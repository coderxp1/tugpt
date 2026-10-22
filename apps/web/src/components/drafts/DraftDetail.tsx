'use client';

// Stage 5A: Draft detail client component
// Displays full draft body, metadata, source message context, action buttons,
// revision history, and event history.
// Amendment 1: Action buttons only visible for draft status. Terminal drafts show no actions.
// Amendment 7: No Send button anywhere. Stale-version conflict with reload action.

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { DraftDetail as DraftDetailType, ApiError } from '@/lib/draft-api/types';
import { apiErrorText } from '@/lib/draft-api/error-text';
import { formatDateTime } from '@/i18n';
import { useT } from '@/i18n/provider';
import { DraftActions } from './DraftActions';
import { DeliveryStatusPanel } from './DeliveryStatus';
import { DraftRevisionHistory } from './DraftRevisionHistory';
import { DraftEventHistory } from './DraftEventHistory';
import { ConversationThread } from './ConversationThread';

export function DraftDetail({ draftId }: { draftId: string }) {
  const t = useT();
  const [draft, setDraft] = useState<DraftDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [featureUnavailable, setFeatureUnavailable] = useState(false);
  const [staleVersion, setStaleVersion] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const handleActionComplete = () => {
    // Show the loading state again while the refetch is in flight. Without
    // this the action buttons stay live on the pre-action version for the
    // duration of the round trip, so an immediate second action sends a stale
    // version and comes back 409 "modified by another reviewer" — blaming a
    // second reviewer for the first one's own edit.
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const handleStaleVersion = () => {
    setStaleVersion(true);
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/v1/drafts/${draftId}`, {
          headers: { 'Content-Type': 'application/json' },
        });

        if (cancelled) return;

        if (res.status === 503) {
          setFeatureUnavailable(true);
          setLoading(false);
          return;
        }

        if (res.status === 404) {
          setNotFound(true);
          setLoading(false);
          return;
        }

        if (res.status === 401) {
          setError(t('errors.UNAUTHENTICATED'));
          setLoading(false);
          return;
        }

        if (!res.ok) {
          const data: ApiError = await res.json();
          if (cancelled) return;
          setError(apiErrorText(t, data));
          setLoading(false);
          return;
        }

        const data = await res.json();
        if (cancelled) return;
        setDraft(data.draft);
        setError(null);
        setNotFound(false);
        setFeatureUnavailable(false);
        setStaleVersion(false);
      } catch {
        if (!cancelled) setError(t('drafts.detail.loadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    return () => { cancelled = true; };
  }, [draftId, reloadKey, t]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-zinc-500">{t('drafts.detail.loading')}</p>
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

  if (notFound) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-zinc-600">{t('drafts.detail.notFound')}</p>
        <Link
          href="/dashboard/drafts"
          className="mt-4 text-sm font-medium text-blue-600 hover:underline"
        >
          {t('drafts.detail.backToInbox')}
        </Link>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-red-600">{error}</p>
        <button
          onClick={() => setReloadKey((k) => k + 1)}
          className="mt-4 rounded bg-zinc-800 px-4 py-2 text-white hover:bg-zinc-700"
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  if (!draft) return null;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link
        href="/dashboard/drafts"
        className="mb-4 inline-block text-sm text-blue-600 hover:underline"
      >
        &larr; {t('drafts.detail.backToInbox')}
      </Link>

      {/* Stale version conflict */}
      {staleVersion && (
        <div className="mb-4 rounded-lg border border-orange-300 bg-orange-50 p-4">
          <p className="text-orange-800">{t('drafts.detail.stale')}</p>
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="mt-2 rounded bg-orange-600 px-4 py-2 text-sm text-white hover:bg-orange-700"
          >
            {t('common.reload')}
          </button>
        </div>
      )}

      {/* Draft header */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-zinc-900">{t('drafts.detail.title')}</h1>
        <StatusBadge status={draft.status} />
      </div>

      {/* Draft metadata */}
      <div className="mb-6 grid grid-cols-2 gap-4 text-sm text-zinc-600">
        <div>{t('drafts.detail.version', { version: draft.version })}</div>
        {draft.provider && <div>{t('drafts.detail.provider', { provider: draft.provider })}</div>}
        {draft.model && <div>{t('drafts.detail.model', { model: draft.model })}</div>}
        <div>{t('drafts.detail.created', { at: formatDateTime(draft.created_at, t.locale) })}</div>
        <div>{t('drafts.detail.updated', { at: formatDateTime(draft.updated_at, t.locale) })}</div>
        {draft.reviewed_at && (
          <div>{t('drafts.detail.reviewed', { at: formatDateTime(draft.reviewed_at, t.locale) })}</div>
        )}
        {draft.rejected_at && (
          <div>{t('drafts.detail.rejected', { at: formatDateTime(draft.rejected_at, t.locale) })}</div>
        )}
      </div>

      {/* Draft body */}
      <div className="mb-6">
        <h2 className="mb-2 text-lg font-semibold text-zinc-800">
          {t('drafts.detail.contentHeading')}
        </h2>
        <pre className="whitespace-pre-wrap rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-800">
          {draft.current_revision_body || t('drafts.detail.noContent')}
        </pre>
      </div>

      {/* Source message context */}
      {draft.source_message && (
        <div className="mb-6">
          <h2 className="mb-2 text-lg font-semibold text-zinc-800">
            {t('drafts.detail.sourceHeading')}
          </h2>
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
            <p className="text-sm text-zinc-700">
              {draft.source_message.body || t('drafts.detail.noSourceBody')}
            </p>
            <div className="mt-2 flex gap-4 text-xs text-zinc-400">
              <span>
                {t('drafts.detail.direction', {
                  direction: t(`drafts.direction.${draft.source_message.direction}`),
                })}
              </span>
              <span>
                {t('drafts.detail.received', {
                  at: formatDateTime(draft.source_message.created_at, t.locale),
                })}
              </span>
              {draft.source_message.contact_display && (
                <span>
                  {t('drafts.detail.from', { contact: draft.source_message.contact_display })}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/*
        The conversation, as a thread rather than a status line.

        This block used to render one field — the conversation's status — under
        a heading called "Conversation". A reviewer approving a reply on behalf
        of a business had the AI's guess and the single message it answered, and
        nothing to judge either against: not whether the customer had asked the
        same thing twice, not whether the shop had already replied an hour ago.
        The thread is the Sep 18 milestone and it carries the status in its own
        header, so nothing is lost by replacing this.
      */}
      {draft.conversation && <ConversationThread draftId={draft.id} />}

      {/* Action buttons — only for draft status, not terminal */}
      {draft.status === 'draft' && (
        <DraftActions
          draftId={draft.id}
          version={draft.version}
          currentBody={draft.current_revision_body ?? null}
          onActionComplete={handleActionComplete}
          onStaleVersion={handleStaleVersion}
        />
      )}

      {/* Delivery status — present once an approval has enqueued one */}
      <DeliveryStatusPanel draftId={draft.id} refreshKey={reloadKey} />

      {/* Revision history */}
      <DraftRevisionHistory draftId={draft.id} currentVersion={draft.version} />

      {/* Event history */}
      <DraftEventHistory draftId={draft.id} />
    </div>
  );
}

function StatusBadge({ status }: { status: DraftDetailType['status'] }) {
  const t = useT();
  const styles: Record<DraftDetailType['status'], string> = {
    draft: 'bg-yellow-100 text-yellow-800',
    approved: 'bg-green-100 text-green-800',
    rejected: 'bg-red-100 text-red-800',
  };
  return (
    <span className={`rounded-full px-3 py-1 text-sm font-medium ${styles[status]}`}>
      {t(`drafts.status.${status}`)}
    </span>
  );
}
