'use client';

// Stage 5A: Draft inbox client component
// Displays draft list with status filter, pagination, and all UI states.
// Amendment 7: Includes empty inbox, feature unavailable, and no Send button states.
//
// 2026-08-30: every string moved into the dictionaries (ADR-017). Two things
// changed that are not translation:
//
//   * Retry did nothing. It called `setPage((p) => p)`, which sets the same
//     value, so React bailed out and the effect never re-ran — on the one
//     control whose entire job is to re-run the effect. Now a `reloadKey`, the
//     same mechanism DraftDetail already used.
//   * Status and filter labels were `status.charAt(0).toUpperCase() + …` on the
//     raw database enum, which is a way of rendering English no dictionary can
//     reach. They are keys now, and the compiler checks every case exists.

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { DraftListItem, ApiError } from '@/lib/draft-api/types';
import { apiErrorText } from '@/lib/draft-api/error-text';
import { DeliveryBadge } from './DeliveryStatus';
import { formatDateTime } from '@/i18n';
import { useT } from '@/i18n/provider';

type StatusFilter = 'all' | 'draft' | 'approved' | 'rejected';

const STATUS_FILTERS: StatusFilter[] = ['all', 'draft', 'approved', 'rejected'];

export function DraftInbox() {
  const t = useT();
  const [drafts, setDrafts] = useState<DraftListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [featureUnavailable, setFeatureUnavailable] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const params = new URLSearchParams({
          status: statusFilter,
          page: String(page),
          limit: String(limit),
        });
        const res = await fetch(`/api/v1/drafts?${params}`, {
          headers: { 'Content-Type': 'application/json' },
        });

        if (cancelled) return;

        if (res.status === 503) {
          setFeatureUnavailable(true);
          setDrafts([]);
          setLoading(false);
          return;
        }

        if (res.status === 401) {
          setError(t('errors.UNAUTHENTICATED'));
          setDrafts([]);
          setLoading(false);
          return;
        }

        if (!res.ok) {
          const data: ApiError = await res.json();
          if (cancelled) return;
          setError(apiErrorText(t, data));
          setDrafts([]);
          setLoading(false);
          return;
        }

        const data = await res.json();
        if (cancelled) return;
        setDrafts(data.drafts || []);
        setTotal(data.total || 0);
        setError(null);
        setFeatureUnavailable(false);
      } catch {
        if (!cancelled) {
          setError(t('drafts.inbox.loadFailed'));
          setDrafts([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    return () => { cancelled = true; };
  }, [statusFilter, page, limit, reloadKey, t]);

  // The spinner is raised by the handler, not by the effect: React's
  // set-state-in-effect rule is right that an effect setting state on its own
  // first tick is a re-render nobody asked for, and the click is where "this is
  // going to take a moment" is actually known.
  const retry = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-zinc-500">{t('drafts.inbox.loading')}</p>
      </div>
    );
  }

  if (featureUnavailable) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-lg font-medium text-zinc-700">
          {t('drafts.detail.featureUnavailable')}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-red-600">{error}</p>
        <button
          onClick={retry}
          className="mt-4 rounded bg-zinc-800 px-4 py-2 text-white hover:bg-zinc-700"
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold text-zinc-900">{t('drafts.inbox.title')}</h1>

      {/* Status filter */}
      <div className="mb-4 flex gap-2">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => {
              setStatusFilter(s);
              setPage(1);
            }}
            className={`rounded px-3 py-1 text-sm font-medium ${
              statusFilter === s
                ? 'bg-zinc-800 text-white'
                : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
            }`}
          >
            {t(`drafts.filter.${s}`)}
          </button>
        ))}
      </div>

      {/* Empty state */}
      {drafts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <p className="text-zinc-500">{t('drafts.inbox.empty')}</p>
        </div>
      ) : (
        <>
          {/* Draft list */}
          <div className="space-y-3">
            {drafts.map((draft) => (
              <Link
                key={draft.id}
                href={`/dashboard/drafts/${draft.id}`}
                className="block rounded-lg border border-zinc-200 p-4 transition hover:border-zinc-300 hover:shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <p className="text-sm text-zinc-600">
                      {draft.source_message_preview || t('drafts.inbox.noPreview')}
                    </p>
                    <p className="mt-1 text-xs text-zinc-400">
                      {draft.current_revision_body_preview || ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <DeliveryBadge delivery={draft.delivery} />
                    <StatusBadge status={draft.status} />
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-3 text-xs text-zinc-400">
                  <span>v{draft.version}</span>
                  {draft.provider && <span>{draft.provider}</span>}
                  <span>{formatDateTime(draft.created_at, t.locale)}</span>
                </div>
              </Link>
            ))}
          </div>

          {/* Pagination */}
          {total > limit && (
            <div className="mt-6 flex items-center justify-center gap-4">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="rounded px-3 py-1 text-sm disabled:opacity-50"
              >
                {t('common.previous')}
              </button>
              <span className="text-sm text-zinc-500">
                {t('drafts.inbox.pagination', {
                  page,
                  pages: Math.ceil(total / limit),
                })}
              </span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page * limit >= total}
                className="rounded px-3 py-1 text-sm disabled:opacity-50"
              >
                {t('common.next')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: DraftListItem['status'] }) {
  const t = useT();
  const styles: Record<DraftListItem['status'], string> = {
    draft: 'bg-yellow-100 text-yellow-800',
    approved: 'bg-green-100 text-green-800',
    rejected: 'bg-red-100 text-red-800',
  };
  return (
    <span className={`rounded-full px-2 py-1 text-xs font-medium ${styles[status]}`}>
      {t(`drafts.status.${status}`)}
    </span>
  );
}
