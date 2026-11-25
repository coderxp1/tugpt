# Defect: chat requests credentials as broker caller `web`, which the broker forbids

Status: **decision A taken (owner), implemented on branch `agent2/mcp-authenticated-customer`, not deployed.** Found by Agent 2 on 2026-11-21 while wiring B3.

Implementation (local commits, verified by automated tests only, no live broker run yet):
- broker: caller `executor` with `get_access_token` + `get_static_secret` only (`9ff63ae` RED, `d5b6721` GREEN);
- web chat: `brokerTokenSource` and the new `brokerStaticSecretSource` sign as `executor` with
  `TUGPT_BROKER_EXECUTOR_KEY`; the web key is never used for reads (`6df3c6c` RED, `42c63a7` GREEN,
  `apps/web/src/lib/chat/broker-executor.test.ts`).

Residual risk (stated, not solved): the web key and the executor key are both held by the same Next.js
server process. The split limits what each key can do at the broker and makes misuse auditable per caller;
it does not protect against a full compromise of that process. Moving execution to a separate worker
process would; that is a later architecture decision.

## Evidence (code + existing passing test; not a live run)

- `packages/credential-broker/src/authz.ts`: `web` may `store_oauth_result`, `connection_status`, `revoke`, `store_static_secret` only. `get_access_token` and `get_static_secret` are `worker`-only.
- `packages/credential-broker/src/server.ts:105-107`: any operation outside the matrix returns **403 FORBIDDEN**; `server.test.ts:70` asserts exactly `{caller:'web', operation:'get_access_token'}` is refused.
- `apps/web/src/lib/chat/connect.ts:128`: chat's `brokerTokenSource` builds `new BrokerClient({ caller: 'web', ... })` and calls `getAccessToken`.
- Chat tests (`connect.test.ts`) inject a fake token source, so the mismatch never surfaced.

Consequence: with a real broker, every chat tool call that needs a stored credential (Google/Microsoft OAuth tools today, authenticated customer MCP after B3) fails with FORBIDDEN. Unauthenticated MCP is unaffected (`MCP_NO_CREDENTIAL`).

## Options

| Option | Effect | Trade-off |
|---|---|---|
| A. New caller `executor` with its own key, allowed `get_access_token` + `get_static_secret` only; used only by the server-side chat execution path | Keeps `web` (callbacks, admin forms) write-only; least code change | The key still lives in the Next server process; the boundary is key separation + audit, not process isolation |
| B. Move tool execution to the worker (queue), web never reads credentials | Strongest isolation; matches the original matrix intent | Large change to chat streaming/approval flow; touches areas outside Agent 2 |
| C. Allow `web` to read | Smallest change | Collapses the designed separation; not recommended |

Agent 2 recommendation: **A now** (separate key, separate audit caller, rate limit per caller), **B as the target** once the worker execution path exists.
