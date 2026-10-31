# Private GPU image service

## Verified execution, not a production-completion claim

The H200 NVL host generated real PNGs using pinned, Apache-2.0 Z-Image-Turbo weights. The image executor is deployed as a dedicated unprivileged service on **127.0.0.1:18765 only**, with a private bearer token and offline model loading. No bridge, reverse-tunnel authentication, SSH configuration, Ollama configuration, or public inference endpoint was changed.

Final measured runtime: PyTorch 2.14.1+cu130, CUDA runtime 13.0, existing NVIDIA driver 580.178.04. For 1024 by 1024, BF16, 9 pipeline steps, guidance 0, seeds 42/43/44: first render 2.829 s; warm renders 1.556 s and 1.560 s; model load 2.515 s. Peak allocated tensors 22,212 MiB, peak device memory 25,775 MiB, sampled GPU utilization peak 100%. These are three local runs, not throughput/SLA promises. Final environment dependency check passed and pip-audit reported no known vulnerabilities.

The private HTTP API also generated square, landscape and portrait PNGs, checked actual dimensions and signatures, persisted results, rejected unauthenticated requests and cross-organization retrieval, and reconciled duplicate submission IDs.

**The application-to-Supabase-to-GPU-to-private-storage end-to-end path has not yet been run.** `worker.py` is implemented and contract-tested, but no configured nonproduction Supabase connection was found in the development workspaces. It must remain disabled until the correct project and test organization are supplied through protected configuration. No production feature flags were enabled.

## Architecture

- Reuse existing TuGPT media API, authentication, organization resolution, quotas, job history, RLS and private signed result URLs.
- Run `worker.py` on the GPU host, beside the executor. It pulls the existing Supabase media queue over outbound HTTPS; no tunnel or public inference access is needed.
- Queue identity comes from the claimed database row. The deterministic job UUID is recorded before submission; repeated submission is idempotent, including after uncertain network responses.
- The worker renews the queue lease, respects feature gates, checks cancellation, uploads only to `media/<organization>/<job>.png`, calls the existing completion RPC, and deletes the queue message last.
- The GPU service has a single execution thread, SQLite WAL persistence, one active request per organization, a global queue bound of 16, bounded bodies, fixed resolution/step limits and a 5 GiB local-result storage ceiling. Reached storage ceiling rejects new work; automatic retention cleanup is not implemented.
- Cancellation is job-specific; it never interrupts unrelated GPU work globally.
- Interrupted processing jobs fail explicitly on process restart and are never silently re-rendered.
- GPU percentage progress is available in the private executor API. The existing customer UI shows job lifecycle status; percentage progress is not yet persisted into the application database.
- The bearer token grants trusted service access, not browser/end-user access. Never distribute it to customers.

## Installation and operation

Use a dedicated `tugpt-ai` service identity and isolated virtual environment. The currently deployed home is `/srv/tugpt-ai`, with separate `src`, `models`, `state` and `evidence` directories. Keep state and token permissions private.

Install the official CUDA 13.0 PyTorch wheel separately:

```sh
python -m pip install torch==2.14.1 --index-url https://download.pytorch.org/whl/cu130
python -m pip install -r requirements.txt
python -m pip check
```

Download only the revisions in `models.json`, verify the repository license and gating before download, and use safetensors/config/tokenizer files without remote Python execution. Write the absolute pinned image snapshot directory to `/srv/tugpt-ai/state/image-model-path`. The executor verifies the revision directory. Preserve license/model-card information. Create a cryptographically random token in `/srv/tugpt-ai/state/api-token`, mode 0600, owned by the service user; never print it or commit it.

Run exactly one server process:

```sh
HF_HUB_OFFLINE=1 HF_HOME=/srv/tugpt-ai/models \
  uvicorn server:create_app --factory --host 127.0.0.1 --port 18765 \
  --workers 1 --no-access-log
```

The deployed service additionally uses systemd `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, a private temporary directory, a 64 GiB memory cap, a private umask, and IP restrictions allowing localhost only. Only the state directory is writable. Do not widen the bind or add a public proxy.

The separate outbound worker needs `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in a protected environment file. Do not paste credentials in a chat, shell command, source file or log. Start with a designated staging project and organization. The private `media` bucket and existing migrations must already be applied. Confirm quota behavior, real storage authorization, cancellation and cross-tenant denial with two real staging users before enabling customer use.

The full local application candidate also adds `MEDIA_IMAGE_PROVIDER=z-image-turbo` handling to validate fixed image resources, hide unsupported video/negative-prompt controls, bound request bodies, and retain idempotency keys across network retries. Those application edits are tracked separately on the local `feat/gpu-image-generation` branch; this publication initially isolates the GPU service.

## Tests and model evaluation

```sh
pytest -q test_pipeline.py
```

22 service/worker tests pass. Worker RPC tests use HTTP contract doubles and do **not** prove real Supabase deployment. Separate real-GPU HTTP checks generated actual PNGs. The full local application candidate passed 44 uncached lint/typecheck/test/build tasks.

Qwen3-8B and Qwen3-Embedding-0.6B were also downloaded at the pinned Apache-2.0 revisions and executed locally with `trust_remote_code=False`. Bounded smoke tests covered German, Spanish and a simple Python function; warm text rates were about 50 and 73 tokens/s. A three-text embedding batch produced 1024-dimensional vectors and ranked the relevant appointment-reminder passage above an unrelated bakery passage. These are smoke tests, not broad quality acceptance. Neither model is routed into customer chat yet.

The next customer feature under development is tenant-scoped semantic knowledge retrieval. The local TypeScript capability contracts and ranking helper enforce organization and embedding-revision isolation before ranking; no live knowledge index migration or production retrieval switch has been performed.

## Remaining release gates

1. Configure an approved nonproduction Supabase project and test organization through protected secrets.
2. Run authenticated browser submission through the actual application, real queue, GPU inference, private storage and signed retrieval; test a second organization and quota/cancellation failure cases.
3. Publish/review the complete local application integration candidate, preserving the separately prepared security baseline.
4. Add production retention/reconciliation operations, broader load/quality testing and monitoring before customer rollout.

Video remains unsupported by this service and is rejected rather than simulated. No external paid provider was called.
