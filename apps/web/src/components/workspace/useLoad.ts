'use client';

import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceResult } from '@/lib/workspace-data/contracts';
import { problemOf, type Failure, type ServiceProblem } from '@/lib/workspace/service';

export type Loadable<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: T }
  | { readonly state: 'error'; readonly problem: ServiceProblem; readonly failure: Pick<Failure, 'status' | 'error'> };

/**
 * Loads one resource from the Workspace API. `key` names what is loaded (change it to load
 * something else); `reload()` tries again and shows the loading state while it does. `validate`
 * rejects a response that does not have the contract's shape (an older route on this server),
 * which is reported as unavailable rather than rendered half-broken.
 * State is only set when a request settles, never synchronously inside the effect.
 */
export function useLoad<T>(key: string | null, fn: () => Promise<WorkspaceResult<T>>, validate: (v: unknown) => boolean = () => true) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string | null; attempt: number; value: Loadable<T> }>({ key: null, attempt: -1, value: { state: 'loading' } });

  useEffect(() => {
    if (key === null) return;
    let live = true;
    fn().then((r) => {
      if (!live) return;
      const value: Loadable<T> = r.ok
        ? (validate(r.value) ? { state: 'ready', value: r.value } : { state: 'error', problem: 'unavailable', failure: { status: 404, error: 'UNEXPECTED_RESPONSE' } })
        : { state: 'error', problem: problemOf(r), failure: { status: r.status, error: r.error } };
      setResult({ key, attempt, value });
    });
    return () => { live = false; };
    // fn/validate are read when key or attempt change; callers pass inline lambdas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  /** Optimistic local update after a successful mutation (no refetch needed). */
  const update = useCallback((next: (v: T) => T) => setResult((r) => (r.value.state === 'ready' ? { ...r, value: { state: 'ready', value: next(r.value.value) } } : r)), []);
  const current: Loadable<T> = key !== null && result.key === key && result.attempt === attempt ? result.value : { state: 'loading' };
  return { load: current, reload, update } as const;
}
