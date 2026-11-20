/**
 * Minimal JSON Schema argument check for customer MCP tools (Agent 2, MCP reliability).
 *
 * Purpose: reject a model-proposed call whose arguments cannot satisfy the APPROVED snapshot's inputSchema
 * before the per-call approval is claimed, so an approval card is never shown for, and an approval never
 * consumed by, a call the customer server would refuse anyway. The customer server stays the final validator.
 *
 * Supported keywords: type (string or array), enum, required, properties, additionalProperties (false or a
 * schema), items (single schema), minimum, maximum, minLength, maxLength. Any other keyword ($ref, anyOf,
 * oneOf, allOf, format, pattern, ...) is ignored, i.e. accepted, never guessed at.
 *
 * Fail-closed limits: schema nesting deeper than MAX_SCHEMA_DEPTH rejects the call.
 *
 * The returned detail goes back to the MODEL so it can correct the call. The schema came from an external
 * server (admin-approved, still untrusted text), so only plain identifiers are echoed as paths; anything else
 * becomes "<property>". Messages are fixed strings plus JSON type names, at most MAX_DETAIL_ISSUES issues and
 * MAX_DETAIL_CHARS characters.
 */
export const MAX_SCHEMA_DEPTH = 32;
export const MAX_DETAIL_ISSUES = 5;
export const MAX_DETAIL_CHARS = 512;

const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const KNOWN_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array']);
const MAX_COLLECTED = 50;

export type ArgsCheck = { readonly ok: true } | { readonly ok: false; readonly detail: string };

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o: Rec, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function matchesType(t: string, v: unknown): boolean {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    case 'object': return isRecord(v);
    case 'array': return Array.isArray(v);
    default: return true;
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

const seg = (name: string) => (SAFE_NAME.test(name) ? name : '<property>');
const child = (path: string, name: string) => (path ? `${path}.${seg(name)}` : seg(name));
const label = (path: string) => path || 'arguments';

interface State { issues: string[]; tooDeep: boolean }

function check(schema: unknown, value: unknown, path: string, depth: number, st: State): void {
  if (st.tooDeep || st.issues.length >= MAX_COLLECTED) return;
  if (depth > MAX_SCHEMA_DEPTH) { st.tooDeep = true; return; }
  if (!isRecord(schema)) return; // `true`, `{}` or malformed: no constraint we can enforce.

  const rawTypes = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
  const types = rawTypes.filter((t): t is string => typeof t === 'string' && KNOWN_TYPES.has(t));
  if (types.length > 0 && !types.some((t) => matchesType(t, value))) {
    st.issues.push(`${label(path)}: expected ${types.join(' or ')}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => sameJson(e, value))) {
    st.issues.push(`${label(path)}: not one of the allowed values`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) st.issues.push(`${label(path)}: below the minimum`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) st.issues.push(`${label(path)}: above the maximum`);
  }
  if (typeof value === 'string') {
    const len = [...value].length;
    if (typeof schema.minLength === 'number' && len < schema.minLength) st.issues.push(`${label(path)}: too short`);
    if (typeof schema.maxLength === 'number' && len > schema.maxLength) st.issues.push(`${label(path)}: too long`);
  }
  if (isRecord(value)) {
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) if (typeof r === 'string' && !own(value, r)) st.issues.push(`${child(path, r)}: required`);
    }
    const props = isRecord(schema.properties) ? schema.properties : {};
    for (const k of Object.keys(value)) {
      if (own(props, k)) check(props[k], value[k], child(path, k), depth + 1, st);
      else if (schema.additionalProperties === false) st.issues.push(`${child(path, k)}: not allowed`);
      else if (isRecord(schema.additionalProperties)) check(schema.additionalProperties, value[k], child(path, k), depth + 1, st);
    }
  }
  if (Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((item, i) => check(schema.items, item, `${label(path)}[${i}]`, depth + 1, st));
  }
}

/** Checks `value` against `schema`; see the module comment for the supported subset and the detail format. */
export function checkArgumentsAgainstSchema(schema: unknown, value: unknown): ArgsCheck {
  const st: State = { issues: [], tooDeep: false };
  check(schema, value, '', 0, st);
  if (st.tooDeep) return { ok: false, detail: 'arguments: the tool schema is nested too deeply to check' };
  if (st.issues.length === 0) return { ok: true };
  const shown = st.issues.slice(0, MAX_DETAIL_ISSUES);
  const more = st.issues.length - shown.length;
  const detail = shown.join('; ') + (more > 0 ? `; and ${more}${st.issues.length >= MAX_COLLECTED ? '+' : ''} more` : '');
  return { ok: false, detail: detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS - 3)}...` : detail };
}
