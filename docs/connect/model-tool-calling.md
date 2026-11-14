# Model tool-calling — evidence, limits, adapter recommendation

Status: **documentation evidence + offline contract tests. Live probe NOT yet run.**
Owner decision 2026-11-12 #3 (dev/staging only, non-sensitive data, no
production credentials, no extra cost without approval).

## 1. What is proven, and how

| Claim | Evidence type | Where |
|---|---|---|
| Langdock's OpenAI-compatible endpoint accepts all Chat Completions params except `n`, `service_tier`, `parallel_tool_calls`, `stream_options` — so `tools` / `tool_choice` are documented as supported | Vendor docs (read 2026-11-14) | <https://docs.langdock.com/api-endpoints/completion/openai> |
| Default limits 500 RPM (per workspace+model+key), 150k TPM (shared per model); 429 on excess | Vendor docs | same page |
| Browser-origin calls are blocked → server-side only | Vendor docs | same page |
| Our adapter never sends the four unsupported params, nor `temperature`/`max_tokens` | Unit test + mutation (adding `parallel_tool_calls:false` fails a test) | `packages/ai-providers/src/tool-calling.test.ts` |
| Unknown tool names, invalid JSON, non-object or >16 KiB args, duplicate ids are rejected, never surfaced as callable | Unit tests + mutations (M1, M4) | same |
| Per-call model override cannot bypass the cost allowlist | Unit test + mutation (M3) | same |
| Multiple tool calls in one response are returned in order | Unit test | same |
| No model is advertised as tool-capable without probe evidence (`verifiedToolModels` defaults to empty) | Unit test | same |
| Probe refuses in production / without `--confirm-nonprod` / with a group-readable key file; hard cap of 16 requests | Unit tests + CLI run (exit 2 in all four refusal cases) | `tool-calling-probe.test.ts`, evidence log |

**Not proven:** that any of `gpt-5-mini`, `gpt-5.1`, `gpt-5.2`, `gpt-5`
actually returns well-formed `tool_calls` through Langdock in our workspace,
their selection accuracy, or real latency/token cost. That requires the live
probe (§3) with a non-production key, which does not exist on the dev VPS
(`provider-secrets.env` contains only comments).

## 2. Known limits that shape the runtime (from docs)

1. **No `parallel_tool_calls` control.** A model may emit several calls in one
   turn. The Connect tool runtime must execute them **serially**, each with
   its own authz check, approval gate (for write tools) and audit row. One
   rejected call must not abort the others silently — it yields a tool
   result with an error the model can see.
2. **No `stream_options`.** Streaming responses carry no usage block. For
   agent/tool turns use **non-streaming** calls (usage is returned) and stream
   only the final text turn, or meter streamed turns by estimate and reconcile
   from Langdock's usage export.
3. **No `n`.** One candidate per request — irrelevant for tools.
4. **Rate limits are per model.** The existing model-rotation
   (`langdock-rotation.ts`) is text-only; tool loops must stay on one model
   for the whole loop (tool-call ids are model-turn-scoped) and must not
   rotate mid-loop.
5. **GPT-5-family parameters.** Reasoning models reject non-default
   `temperature`; the adapter sends none and uses `max_completion_tokens`.
   (Observation: the existing text adapter `langdock.ts` sends
   `temperature: 0.7` and `max_tokens`; whether Langdock tolerates that for
   GPT-5 models should be confirmed by the same probe run — flagged, not
   changed here.)

## 3. Live probe (ready, not run)

`packages/ai-providers/src/tool-calling-probe.ts` + `…-probe-cli.ts`.

| Scenario | Pass condition |
|---|---|
| `multi_call` | "temperature in Berlin and Paris" → ≥1 `get_weather` call, only those cities; notes whether >1 call was emitted |
| `tool_selection` | "free 30-min slot between …" → `calendar_find_availability` with `start`, `end`, `durationMinutes=30`; no unrelated tool |
| `no_tool_needed` | "Reply with the single word: ok" → text, zero tool calls |
| `result_roundtrip` | Synthetic tool results fed back → text answer reflecting them, no further calls (skipped without a request if `multi_call` produced no calls) |

Cost envelope: ≤ 16 requests total (4 models × 4), `max_completion_tokens`
800, sequential, synthetic prompts only. Against the documented per-model
quota this is ≤ 4 requests per model.

Run (owner provisions the key file; never paste the key in chat):

```bash
install -m 600 /dev/null /srv/tugpt-workspace/secrets/langdock-probe.key   # owner writes key here
cd /srv/tugpt-workspace/tugpt-connect/packages/ai-providers && npx tsc -p tsconfig.build.json
LANGDOCK_PROBE_KEY_FILE=/srv/tugpt-workspace/secrets/langdock-probe.key \
  node dist/tool-calling-probe-cli.js --confirm-nonprod \
  --out /srv/tugpt-workspace/tugpt-connect-evidence/tool-calling-probe.json
```

The report contains per-model/scenario pass/fail, finish reason, tool names
and (synthetic) arguments, rejected calls, usage and latency, sanitized error
category — never the key.

## 4. Recommendation

1. **Adopt `ToolCallingModelAdapter` as the only model interface for agents
   and the Connect tool runtime** (ADR-021 D8). Keep `AIProviderAdapter` for
   text drafts; do not widen it.
2. **Gate by evidence:** set `verifiedToolModels` from the probe's
   `recommendedVerifiedModels`; models that fail any scenario are not offered
   for agents. Re-run the probe on model-list changes.
3. **Default agent model:** pick the cheapest model that passes all four
   scenarios (expected `gpt-5-mini`, to be confirmed); allow per-agent
   override among verified models only.
4. **Runtime rules:** non-streaming for tool turns; serial execution; per-call
   authz + approval + audit; a loop budget (max turns, max calls per turn,
   token ceiling) enforced by the runtime, not the model.
5. **If no model passes:** fall back to a deterministic planner (structured
   JSON output validated against a schema) for the Google Calendar slice only;
   do not ship autonomous agents on that path.
