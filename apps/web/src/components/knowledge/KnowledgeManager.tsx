'use client';

/**
 * KnowledgeManager — the owner's FAQ workshop.
 *
 * Lists the workspace's knowledge entries, and supports the four
 * operations the owner actually performs: add, edit, enable/disable,
 * delete — plus the retrieval preview, which answers "what would
 * the assistant use for this question?" with the production
 * selection rules (the preview endpoint runs the same
 * selectKnowledgeEntries the draft worker runs).
 *
 * Authorization is not re-implemented here: the API enforces it
 * (members read, owner/admin write, enforced by RLS in the
 * database). When a write comes back 403, the server's sentence is
 * shown as-is — an agent who cannot change the business's facts
 * learns that from the response, not from a hidden button.
 */

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/provider';
import { apiErrorText } from '@/lib/draft-api/error-text';

interface KnowledgeEntry {
  id: string;
  question: string;
  answer: string;
  enabled: boolean;
}

interface PreviewSelection {
  question: string;
  answer: string;
}

export function KnowledgeManager() {
  const t = useT();
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [newQuestion, setNewQuestion] = useState('');
  const [newAnswer, setNewAnswer] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editQuestion, setEditQuestion] = useState('');
  const [editAnswer, setEditAnswer] = useState('');

  const [previewQuestion, setPreviewQuestion] = useState('');
  const [previewResult, setPreviewResult] = useState<PreviewSelection[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/knowledge');
      const body = await res.json();
      if (!res.ok) {
        setLoadError(apiErrorText(t, body) || t('knowledge.loadError'));
        return;
      }
      setEntries(body.entries as KnowledgeEntry[]);
      setLoadError(null);
    } catch {
      setLoadError(t('knowledge.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/v1/knowledge');
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(apiErrorText(t, body) || t('knowledge.loadError'));
          return;
        }
        setEntries(body.entries as KnowledgeEntry[]);
        setLoadError(null);
      } catch {
        if (!cancelled) setLoadError(t('knowledge.loadError'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const runAction = useCallback(
    async (fn: () => Promise<Response>) => {
      setActionError(null);
      const res = await fn();
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setActionError(apiErrorText(t, body) || t('knowledge.saveError'));
        return false;
      }
      return true;
    },
    [t]
  );

  const addEntry = async () => {
    const ok = await runAction(() =>
      fetch('/api/v1/knowledge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: newQuestion, answer: newAnswer }),
      })
    );
    if (ok) {
      setNewQuestion('');
      setNewAnswer('');
      await load();
    }
  };

  const saveEdit = async (id: string) => {
    const ok = await runAction(() =>
      fetch(`/api/v1/knowledge/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: editQuestion, answer: editAnswer }),
      })
    );
    if (ok) {
      setEditingId(null);
      await load();
    }
  };

  const toggleEnabled = async (entry: KnowledgeEntry) => {
    const ok = await runAction(() =>
      fetch(`/api/v1/knowledge/${entry.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !entry.enabled }),
      })
    );
    if (ok) await load();
  };

  const deleteEntry = async (entry: KnowledgeEntry) => {
    if (!window.confirm(t('knowledge.deleteConfirm'))) return;
    const ok = await runAction(() =>
      fetch(`/api/v1/knowledge/${entry.id}`, { method: 'DELETE' })
    );
    if (ok) await load();
  };

  const runPreview = async () => {
    setPreviewError(null);
    setPreviewResult(null);
    const res = await fetch('/api/v1/knowledge/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: previewQuestion }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      setPreviewError(apiErrorText(t, body) || t('knowledge.saveError'));
      return;
    }
    setPreviewResult(body.selected as PreviewSelection[]);
  };

  return (
    <div>
      <h1>{t('knowledge.title')}</h1>
      <p>{t('knowledge.subtitle')}</p>

      {loadError && <p role="alert">{loadError}</p>}
      {actionError && <p role="alert">{actionError}</p>}

      <section aria-label={t('knowledge.addTitle')}>
        <h2>{t('knowledge.addTitle')}</h2>
        <label>
          {t('knowledge.questionLabel')}
          <input
            value={newQuestion}
            onChange={(e) => setNewQuestion(e.target.value)}
            placeholder={t('knowledge.questionPlaceholder')}
          />
        </label>
        <label>
          {t('knowledge.answerLabel')}
          <textarea
            value={newAnswer}
            onChange={(e) => setNewAnswer(e.target.value)}
            placeholder={t('knowledge.answerPlaceholder')}
          />
        </label>
        <button
          type="button"
          onClick={() => void addEntry()}
          disabled={newQuestion.trim() === '' || newAnswer.trim() === ''}
        >
          {t('knowledge.addButton')}
        </button>
      </section>

      <section>
        {!loading && entries.length === 0 && !loadError && (
          <p>{t('knowledge.empty')}</p>
        )}
        <ul>
          {entries.map((entry) => (
            <li key={entry.id}>
              {editingId === entry.id ? (
                <>
                  <input
                    value={editQuestion}
                    onChange={(e) => setEditQuestion(e.target.value)}
                    aria-label={t('knowledge.questionLabel')}
                  />
                  <textarea
                    value={editAnswer}
                    onChange={(e) => setEditAnswer(e.target.value)}
                    aria-label={t('knowledge.answerLabel')}
                  />
                  <button type="button" onClick={() => void saveEdit(entry.id)}>
                    {t('knowledge.saveButton')}
                  </button>
                  <button type="button" onClick={() => setEditingId(null)}>
                    {t('knowledge.cancelButton')}
                  </button>
                </>
              ) : (
                <>
                  <strong>{entry.question}</strong>
                  <p>{entry.answer}</p>
                  <span>
                    {entry.enabled
                      ? t('knowledge.enabledLabel')
                      : t('knowledge.disabledLabel')}
                  </span>
                  <button type="button" onClick={() => void toggleEnabled(entry)}>
                    {entry.enabled
                      ? t('knowledge.disabledLabel')
                      : t('knowledge.enabledLabel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(entry.id);
                      setEditQuestion(entry.question);
                      setEditAnswer(entry.answer);
                    }}
                  >
                    {t('knowledge.editButton')}
                  </button>
                  <button type="button" onClick={() => void deleteEntry(entry)}>
                    {t('knowledge.deleteButton')}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label={t('knowledge.previewTitle')}>
        <h2>{t('knowledge.previewTitle')}</h2>
        <p>{t('knowledge.previewSubtitle')}</p>
        <input
          value={previewQuestion}
          onChange={(e) => setPreviewQuestion(e.target.value)}
          placeholder={t('knowledge.previewPlaceholder')}
        />
        <button
          type="button"
          onClick={() => void runPreview()}
          disabled={previewQuestion.trim() === ''}
        >
          {t('knowledge.previewButton')}
        </button>
        {previewError && <p role="alert">{previewError}</p>}
        {previewResult !== null &&
          (previewResult.length === 0 ? (
            <p>{t('knowledge.previewNone')}</p>
          ) : (
            <>
              <p>{t('knowledge.previewMatch')}</p>
              <ul>
                {previewResult.map((item) => (
                  <li key={item.question}>
                    <strong>{item.question}</strong>
                    <p>{item.answer}</p>
                  </li>
                ))}
              </ul>
            </>
          ))}
      </section>
    </div>
  );
}
