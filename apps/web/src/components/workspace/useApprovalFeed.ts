'use client';

import { useEffect, useRef, useState } from 'react';
import type { ApprovalRecord, ApprovalStatus } from '@/lib/workspace-data/contracts';
import { hasArray, workspaceApi } from '@/lib/workspace/service';
import type { Capability } from './ThreadsProvider';

export const APPROVAL_POLL_MS = 45_000;

export interface ApprovalDecision { readonly id: string; readonly capability: string; readonly status: ApprovalStatus }
export interface ApprovalFeed {
  readonly available: Capability;
  /** Admins: requests waiting for a decision in the organization. Members: their own pending requests. */
  readonly pending: number;
  /** Members: their requests that were decided since the page opened (newest first). */
  readonly decided: readonly ApprovalDecision[];
}

const DECIDED: ReadonlySet<ApprovalStatus> = new Set(['approved', 'rejected', 'expired', 'revoked']);

/**
 * Approval notifications without a push channel: GET /api/v1/approvals while the tab is visible,
 * every 45 s and when the tab comes back. There is no unread-count endpoint yet (asked of Agent 4,
 * docs/workspace/agent4-coordination.md); this keeps load small (one page of 50) and stops polling
 * entirely when the API is not available on this server.
 */
export function useApprovalFeed(canDecide: boolean): ApprovalFeed {
  const [feed, setFeed] = useState<ApprovalFeed>({ available: 'unknown', pending: 0, decided: [] });
  const seen = useRef(new Map<string, ApprovalStatus>());

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    async function poll() {
      if (stopped) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { schedule(); return; }
      const r = await workspaceApi().listApprovals(canDecide ? { scope: 'org', status: 'pending', limit: 50 } : { scope: 'mine', limit: 50 });
      if (!live) return;
      if (!r.ok || !hasArray(r.value, 'approvals')) {
        // Not deployed / not configured: stop. Other failures: keep the last known state, try later.
        if (!r.ok && (r.status === 404 || r.status === 405 || r.status === 501 || r.status === 503 || r.error === 'UNEXPECTED_RESPONSE')) { stopped = true; setFeed((f) => ({ ...f, available: 'unavailable' })); return; }
        if (r.ok) { stopped = true; setFeed((f) => ({ ...f, available: 'unavailable' })); return; }
        schedule(); return;
      }
      const list = r.value.approvals as readonly ApprovalRecord[];
      const fresh: ApprovalDecision[] = [];
      if (!canDecide) {
        for (const a of list) {
          const before = seen.current.get(a.id);
          if (before === 'pending' && DECIDED.has(a.status)) fresh.push({ id: a.id, capability: a.endpointName ? `${a.endpointName} · ${a.capability}` : a.capability, status: a.status });
          seen.current.set(a.id, a.status);
        }
      }
      setFeed((f) => ({
        available: 'available',
        pending: list.filter((a) => a.status === 'pending').length,
        decided: fresh.length ? [...fresh, ...f.decided].slice(0, 10) : f.decided,
      }));
      schedule();
    }
    function schedule() { if (!stopped && live) timer = setTimeout(() => void poll(), APPROVAL_POLL_MS); }
    function onVisible() { if (document.visibilityState === 'visible' && !stopped) { if (timer) clearTimeout(timer); void poll(); } }

    void poll();
    document.addEventListener('visibilitychange', onVisible);
    return () => { live = false; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [canDecide]);

  return feed;
}
