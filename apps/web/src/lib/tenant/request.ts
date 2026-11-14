/** One precedence rule for SSR, proxy and handlers. Hints are NOT authority.
 * Explicit request header wins over the persisted browser selection. Every
 * caller must resolve it against current memberships before accessing data.
 */
export function getRequestedTenantId(headers: Headers): string | null {
  let value = headers.get('x-tenant-id');
  if (value === null) {
    const matches = (headers.get('cookie') ?? '').split(';').map(c => c.trim())
      .filter(c => c.startsWith('tugpt_tenant_id='));
    if (matches.length > 1) return '!invalid-tenant-hint!';
    if (!matches.length) return null;
    try { value = decodeURIComponent(matches[0].slice('tugpt_tenant_id='.length)); }
    catch { return '!invalid-tenant-hint!'; }
  }
  return value.trim() && value.length <= 128 && !/[\s,;]/.test(value)
    ? value : '!invalid-tenant-hint!';
}
