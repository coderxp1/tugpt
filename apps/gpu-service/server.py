"""Loopback-only, authenticated, durable GPU image executor.
Tenant IDs are supplied by trusted workers from authenticated database jobs.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time
from uuid import UUID
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

SIZES = {(1024, 1024), (1280, 720), (720, 1280)}
ROOT = Path(os.environ.get('TUGPT_AI_STATE', '/srv/tugpt-ai/state'))
REGISTRY = json.loads(Path(__file__).with_name('models.json').read_text())
MODEL = REGISTRY['image.generate']['model']
REVISION = REGISTRY['image.generate']['revision']

class Submission(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: UUID
    organization_id: UUID
    prompt: str = Field(min_length=1, max_length=1000)
    width: int = Field(default=1024, strict=True)
    height: int = Field(default=1024, strict=True)
    seed: int = Field(default=42, ge=0, le=2147483647, strict=True)

    @model_validator(mode='after')
    def validate_image(self):
        if not self.prompt.strip() or (self.width, self.height) not in SIZES:
            raise ValueError('Unsupported image request')
        return self

class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.output = self.root / 'results'
        self.output.mkdir(exist_ok=True, mode=0o700)
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, org TEXT NOT NULL, fingerprint TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER DEFAULT 0, seconds REAL, error TEXT, created REAL NOT NULL)')
            db.commit()

    def connect(self):
        db = sqlite3.connect(self.root / 'jobs.sqlite', timeout=20)
        db.row_factory = sqlite3.Row
        return contextlib.closing(db)

    def recover(self):
        with self.connect() as db:
            db.execute("UPDATE jobs SET status='failed', error='GPU_PROCESS_RESTARTED' WHERE status='processing'")
            db.commit()

    def get(self, job_id, org):
        with self.connect() as db:
            row = db.execute('SELECT * FROM jobs WHERE id=? AND org=?', (str(job_id), str(org))).fetchone()
        if not row:
            raise HTTPException(404, 'JOB_NOT_FOUND')
        return dict(row)

    def submit(self, value):
        data = value.model_dump(mode='json')
        payload = json.dumps(data, sort_keys=True)
        fingerprint = hashlib.sha256(payload.encode()).hexdigest()
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT * FROM jobs WHERE id=?', (data['id'],)).fetchone()
            if old:
                if old['org'] != data['organization_id'] or old['fingerprint'] != fingerprint:
                    raise HTTPException(409, 'IDEMPOTENCY_CONFLICT')
                return dict(old)
            if db.execute("SELECT count(*) FROM jobs WHERE status IN ('queued','processing')").fetchone()[0] >= 16:
                raise HTTPException(429, 'QUEUE_FULL')
            if db.execute("SELECT 1 FROM jobs WHERE org=? AND status IN ('queued','processing')", (data['organization_id'],)).fetchone():
                raise HTTPException(429, 'ORGANIZATION_BUSY')
            if sum(p.stat().st_size for p in self.output.glob('*.png')) > 5 * 1024**3:
                raise HTTPException(507, 'STORAGE_LIMIT')
            db.execute('INSERT INTO jobs(id,org,fingerprint,request,status,created) VALUES (?,?,?,?,?,?)', (data['id'],data['organization_id'],fingerprint,payload,'queued',time.time()))
            db.commit()
        return self.get(data['id'], data['organization_id'])

    def cancel(self, job_id, org):
        self.get(job_id, org)
        with self.connect() as db:
            db.execute("UPDATE jobs SET status='cancelled' WHERE id=? AND org=? AND status IN ('queued','processing')", (str(job_id),str(org)))
            db.commit()
        return self.get(job_id, org)

    def update(self, job_id, **fields):
        assert set(fields) <= {'status','progress','seconds','error'}
        with self.connect() as db:
            db.execute('UPDATE jobs SET ' + ','.join(f'{k}=?' for k in fields) + " WHERE id=? AND status='processing'", (*fields.values(),job_id))
            db.commit()

    def claim(self):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
            if row:
                db.execute("UPDATE jobs SET status='processing' WHERE id=?", (row['id'],))
            db.commit()
        return dict(row) if row else None

def public(row):
    return {k: row[k] for k in ('id','status','progress','seconds','error')}

class Cancelled(Exception):
    pass

class Engine:
    def __init__(self, store):
        self.store = store
        self.stop = threading.Event()
        self.ready = False
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        import torch
        from diffusers import ZImagePipeline
        path = Path(os.environ.get('TUGPT_IMAGE_MODEL_PATH_FILE', '/srv/tugpt-ai/state/image-model-path')).read_text().strip()
        if Path(path).name != REVISION:
            raise RuntimeError('Pinned model revision mismatch')
        pipe = ZImagePipeline.from_pretrained(path, torch_dtype=torch.bfloat16, local_files_only=True).to('cuda')
        self.ready = True
        while not self.stop.is_set():
            row = self.store.claim()
            if not row:
                self.stop.wait(.25)
                continue
            data = json.loads(row['request'])
            def progress(_pipe, step, _timestep, kwargs):
                if self.stop.is_set() or self.store.get(row['id'], row['org'])['status'] == 'cancelled':
                    raise Cancelled()
                self.store.update(row['id'], progress=min(95, (step+1)*10))
                return kwargs
            start = time.perf_counter()
            try:
                torch.cuda.synchronize()
                image = pipe(prompt=data['prompt'], width=data['width'], height=data['height'], num_inference_steps=9, guidance_scale=0.0, generator=torch.Generator('cuda').manual_seed(data['seed']), callback_on_step_end=progress).images[0]
                torch.cuda.synchronize()
                elapsed = time.perf_counter()-start
                target = self.store.output / (row['id']+'.png')
                temporary = target.with_suffix('.tmp')
                image.save(temporary, format='PNG')
                os.replace(temporary, target)
                self.store.update(row['id'], status='completed', progress=100, seconds=elapsed)
                if self.store.get(row['id'], row['org'])['status'] != 'completed':
                    target.unlink(missing_ok=True)
            except Cancelled:
                self.store.update(row['id'], status='failed', error='GPU_SHUTDOWN')
            except Exception:
                self.store.update(row['id'], status='failed', error='GPU_INFERENCE_FAILED')
                print(json.dumps({'event':'gpu_inference_failed','job_id':row['id']}), flush=True)

def create_app(store=None, start_engine=True):
    token = Path(os.environ.get('TUGPT_AI_TOKEN_FILE', '/srv/tugpt-ai/state/api-token')).read_text().strip()
    if len(token) < 32:
        raise RuntimeError('Strong private service token required')
    store = store or Store(ROOT)
    engine = Engine(store)

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        import fcntl
        with (store.root/'executor.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if start_engine:
                store.recover()
                engine.thread.start()
            yield
            engine.stop.set()
            if start_engine:
                engine.thread.join(timeout=30)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware('http')
    async def private_boundary(request: Request, call_next):
        if not secrets.compare_digest(request.headers.get('authorization',''), 'Bearer '+token):
            return JSONResponse({'error':'UNAUTHORIZED'}, status_code=401)
        chunks = []; size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > 8192:
                return JSONResponse({'error':'BODY_TOO_LARGE'}, status_code=413)
            chunks.append(chunk)
        request._body = b''.join(chunks)
        return await call_next(request)

    @app.exception_handler(RequestValidationError)
    async def invalid(_request, _exc):
        return JSONResponse({'error':'INVALID_REQUEST'}, status_code=422)

    @app.get('/health')
    def health():
        return {'ready': engine.ready, 'model':MODEL, 'revision':REVISION, 'capabilities':['image.generate']}

    @app.post('/jobs', status_code=202)
    def submit(value: Submission):
        if not engine.ready and start_engine:
            raise HTTPException(503, 'MODEL_NOT_READY')
        return public(store.submit(value))

    @app.get('/jobs/{job_id}')
    def status(job_id: UUID, organization_id: UUID):
        return public(store.get(job_id, organization_id))

    @app.post('/jobs/{job_id}/cancel')
    def cancel(job_id: UUID, organization_id: UUID):
        return public(store.cancel(job_id, organization_id))

    @app.get('/jobs/{job_id}/result')
    def result(job_id: UUID, organization_id: UUID):
        row = store.get(job_id, organization_id)
        if row['status'] != 'completed':
            raise HTTPException(409, 'RESULT_NOT_READY')
        path = store.output/(str(job_id)+'.png')
        if not path.is_file():
            raise HTTPException(410, 'RESULT_EXPIRED')
        return FileResponse(path, media_type='image/png', headers={'Cache-Control':'no-store'})

    return app
