/**
 * CONF-1 restricted identifiers (tests only). Mirrors Agent 5's release scanner
 * (a5-staging/e2e/leakscan.cjs); keep the two in step.
 */
export const RESTRICTED = /tugpt-scout|\bscout\b|llama[\s._:-]?\d|llama[:/]|meta-llama|\bllama[\s-]+(?:scout|maverick|model)|ollama|h200|nvidia|\bgpu\b|12435|TUGPT_PRIVATE_LLM|PRIVATE_LLM_(URL|MODEL)|127\.0\.0\.1:\d+|\/v1\/chat\/completions/i;
