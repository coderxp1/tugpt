"""Dedicated PGMQ media consumer, co-located with the private GPU executor.
No inbound network path to the GPU is needed. Configure Supabase credentials
through a protected environment file; never pass them on the command line.
"""
import json
import os
from pathlib import Path
import signal
import threading
import time
from urllib.parse import urlsplit
from uuid import UUID
import httpx

TERMINAL = {'completed','cancelled','skipped','dead_lettered'}

class MediaWorker:
    def __init__(self, database, gpu, stop=None):
        self.db = database
        self.gpu = gpu
        self.stop = stop or threading.Event()

    def rpc(self, name, **args):
        response = self.db.post('/rest/v1/rpc/'+name, json=args)
        response.raise_for_status()
        return response.json() if response.content else None

    def job(self, job_id):
        response = self.db.get('/rest/v1/media_generation_jobs', params={
            'id':'eq.'+str(UUID(job_id)),
            'select':'id,organization_id,kind,status,prompt,params,prompt_id,pgmq_msg_id',
            'limit':'1',
        })
        response.raise_for_status()
        rows = response.json()
        if len(rows) != 1:
            raise ValueError('JOB_NOT_FOUND')
        return rows[0]

    def archive(self, msg, job, code):
        self.rpc('archive_media_failed_job', p_msg_id=msg['msg_id'], p_media_job_id=job['id'], p_error_code=code, p_provider_error_detail=None)

    def process(self, msg):
        job_id = str(UUID(msg['payload']['mediaJobId']))
        job = self.job(job_id)
        if str(job['pgmq_msg_id']) != str(msg['msg_id']):
            raise ValueError('QUEUE_IDENTITY_MISMATCH')
        org = str(UUID(job['organization_id']))
        query = {'organization_id':org}
        endpoint = '/jobs/'+job_id
        def cancel_gpu():
            response = self.gpu.post(endpoint+'/cancel', params=query)
            if response.status_code != 404:
                response.raise_for_status()
        if job['status'] in TERMINAL:
            if job['status'] != 'completed':
                cancel_gpu()
            self.rpc('delete_media_job', p_msg_id=msg['msg_id'])
            return
        enabled = self.rpc('is_feature_enabled', p_organization_id=org, p_flag_key='media_generation')
        if enabled is not True:
            cancel_gpu()
            self.rpc('skip_media_job', p_media_job_id=job_id, p_msg_id=msg['msg_id'], p_skip_reason='FEATURE_DISABLED')
            return
        if job['kind'] != 'image':
            self.archive(msg,job,'MEDIA_MODEL_UNAVAILABLE')
            return
        params = job['params'] or {}
        if set(params)-{'width','height','seed'}:
            self.archive(msg,job,'MEDIA_MODEL_UNAVAILABLE')
            return
        if job['prompt_id'] and job['prompt_id'] != job_id:
            # Never take over an outstanding job submitted by another provider.
            self.archive(msg,job,'MEDIA_MODEL_UNAVAILABLE')
            return
        # Save deterministic identity BEFORE submission. A timeout/restart can
        # repeat the same request safely; the GPU store rejects payload changes.
        self.rpc('record_media_submission', p_job_id=job_id, p_prompt_id=job_id)
        response = self.gpu.post('/jobs', json={'id':job_id,'organization_id':org,'prompt':job['prompt'],**params})
        if response.status_code in {409,422}:
            self.archive(msg,job,'MEDIA_PROVIDER_ERROR')
            return
        response.raise_for_status()
        deadline = time.monotonic()+480
        while not self.stop.is_set():
            # Every iteration refreshes the lease. Any failed refresh stops work
            # immediately; redelivery reconciles the same durable GPU identity.
            lease = self.rpc('set_media_visibility', p_msg_id=msg['msg_id'], p_visibility_timeout_seconds=600)
            if lease is not True:
                raise RuntimeError('LEASE_LOST')
            current = self.job(job_id)
            if current['status'] in TERMINAL:
                if current['status'] != 'completed':
                    cancel_gpu()
                self.rpc('delete_media_job',p_msg_id=msg['msg_id'])
                return
            response = self.gpu.get(endpoint,params=query)
            response.raise_for_status()
            result = response.json()
            if result['status'] == 'completed':
                image = self.gpu.get(endpoint+'/result',params=query)
                image.raise_for_status()
                if len(image.content)>16*1024*1024 or image.content[:8]!=b'\x89PNG\r\n\x1a\n':
                    self.archive(msg,job,'MEDIA_STORAGE_ERROR')
                    return
                key = org+'/'+job_id+'.png'
                uploaded = self.db.post('/storage/v1/object/media/'+key,content=image.content,headers={'Content-Type':'image/png','x-upsert':'true'})
                uploaded.raise_for_status()
                # The database checks status and exact tenant/job object key.
                # A cancelled race cannot turn into a completed job.
                self.rpc('complete_media_job',p_job_id=job_id,p_result_path=key,p_gpu_seconds=result['seconds'])
                self.rpc('delete_media_job',p_msg_id=msg['msg_id'])
                return
            if result['status'] in {'failed','cancelled'}:
                self.archive(msg,job,'MEDIA_PROVIDER_ERROR')
                return
            if time.monotonic()>=deadline:
                cancel_gpu()
                self.archive(msg,job,'MEDIA_TIMEOUT')
                return
            self.stop.wait(2)

    def run(self):
        while not self.stop.is_set():
            try:
                messages = self.rpc('read_media_jobs',p_visibility_timeout_seconds=600,p_limit=1)
                for msg in messages:
                    self.process(msg)
            except Exception:
                # Do not print HTTP exception bodies/URLs or credentials. Leave
                # uncertain work leased for idempotent reconciliation, not retry.
                print(json.dumps({'event':'media_worker_iteration_failed'}),flush=True)
            self.stop.wait(5)

def main():
    url = os.environ['NEXT_PUBLIC_SUPABASE_URL'].rstrip('/')
    parsed = urlsplit(url)
    if parsed.scheme!='https' and not (parsed.scheme=='http' and parsed.hostname in {'127.0.0.1','localhost','::1'}):
        raise RuntimeError('HTTPS or loopback database required')
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RuntimeError('Invalid database URL')
    key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
    token = Path(os.environ.get('TUGPT_AI_TOKEN_FILE','/srv/tugpt-ai/state/api-token')).read_text().strip()
    stop = threading.Event()
    for signum in (signal.SIGINT,signal.SIGTERM):
        signal.signal(signum,lambda *_:stop.set())
    with httpx.Client(base_url=url,headers={'apikey':key,'Authorization':'Bearer '+key},timeout=30,follow_redirects=False,trust_env=False) as db:
        with httpx.Client(base_url='http://127.0.0.1:18765',headers={'Authorization':'Bearer '+token},timeout=30,follow_redirects=False,trust_env=False) as gpu:
            MediaWorker(db,gpu,stop).run()

if __name__=='__main__':
    main()
