'use client';

// Stage 5A: Draft action buttons (Approve, Edit, Reject)
// Amendment 1: Only visible when status is draft. Terminal drafts show no actions.
// Amendment 7: No Send or Send to WhatsApp control anywhere.
// Handles optimistic lock version and stale-version conflict.
//
// 2026-08-19: the editor now opens on the draft it is editing. It previously
// opened empty, so changing one word in an AI draft meant retyping the whole
// thing — in a product whose premise is AI drafts plus human edit. Found by
// reading the browser path the milestone-1 harness never exercises, because
// the harness calls edit_draft directly with a body.

import { useState } from 'react';
import type { ApiError } from '@/lib/draft-api/types';
import { apiErrorText } from '@/lib/draft-api/error-text';
import { useT } from '@/i18n/provider';

interface DraftActionsProps {
  draftId: string;
  version: number;
  /**
   * The body the reviewer is looking at. Seeds the editor when Edit is
   * clicked, so an edit starts from the draft rather than from nothing.
   * Null when the draft has no readable revision.
   */
  currentBody: string | null;
  onActionComplete: () => void;
  onStaleVersion: () => void;
}

export function DraftActions({
  draftId,
  version,
  currentBody,
  onActionComplete,
  onStaleVersion,
}: DraftActionsProps) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const handleApprove = async () => {
    setSubmitting(true);
    setError(null);
    setPermissionDenied(false);

    try {
      const res = await fetch(`/api/v1/drafts/${draftId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tugpt-csrf': '1' },
        body: JSON.stringify({ expectedLockVersion: version }),
      });

      if (res.status === 403) {
        setPermissionDenied(true);
        return;
      }

      if (res.status === 409) {
        onStaleVersion();
        return;
      }

      if (!res.ok) {
        const data: ApiError = await res.json();
        setError(apiErrorText(t, data));
        return;
      }

      onActionComplete();
    } catch {
      setError(t('drafts.actions.approveFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    setSubmitting(true);
    setError(null);
    setPermissionDenied(false);

    try {
      const res = await fetch(`/api/v1/drafts/${draftId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tugpt-csrf': '1' },
        body: JSON.stringify({ expectedLockVersion: version }),
      });

      if (res.status === 403) {
        setPermissionDenied(true);
        return;
      }

      if (res.status === 409) {
        onStaleVersion();
        return;
      }

      if (!res.ok) {
        const data: ApiError = await res.json();
        setError(apiErrorText(t, data));
        return;
      }

      onActionComplete();
    } catch {
      setError(t('drafts.actions.rejectFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditSubmit = async () => {
    if (!editBody.trim()) {
      setError(t('drafts.actions.emptyBody'));
      return;
    }

    setSubmitting(true);
    setError(null);
    setPermissionDenied(false);

    try {
      const res = await fetch(`/api/v1/drafts/${draftId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tugpt-csrf': '1' },
        body: JSON.stringify({ expectedLockVersion: version, body: editBody }),
      });

      if (res.status === 403) {
        setPermissionDenied(true);
        return;
      }

      if (res.status === 409) {
        onStaleVersion();
        return;
      }

      if (!res.ok) {
        const data: ApiError = await res.json();
        setError(apiErrorText(t, data));
        return;
      }

      setEditing(false);
      setEditBody('');
      onActionComplete();
    } catch {
      setError(t('drafts.actions.editFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  if (permissionDenied) {
    return (
      <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4">
        <p className="text-red-700">{t('drafts.actions.permissionDenied')}</p>
      </div>
    );
  }

  return (
    <div className="mb-6">
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {editing ? (
        <div className="space-y-3">
          <textarea
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 p-3 text-sm"
            rows={6}
            placeholder={t('drafts.actions.editPlaceholder')}
          />
          <div className="flex gap-2">
            <button
              onClick={handleEditSubmit}
              disabled={submitting}
              className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? t('drafts.actions.saving') : t('drafts.actions.save')}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setEditBody('');
                setError(null);
              }}
              disabled={submitting}
              className="rounded border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={handleApprove}
            disabled={submitting}
            className="rounded bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50"
          >
            {submitting ? t('drafts.actions.processing') : t('drafts.actions.approve')}
          </button>
          <button
            onClick={() => {
              // Seeded here rather than in useState so it always reflects the
              // latest body, including after a reload or another reviewer's
              // edit. A useState initialiser would capture the first render.
              setEditBody(currentBody ?? '');
              setEditing(true);
            }}
            disabled={submitting}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {t('drafts.actions.edit')}
          </button>
          <button
            onClick={handleReject}
            disabled={submitting}
            className="rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
          >
            {submitting ? t('drafts.actions.processing') : t('drafts.actions.reject')}
          </button>
        </div>
      )}
    </div>
  );
}
