'use client';

/**
 * @file ConversationThread.tsx
 * @description The customer's history, beside the draft. The Sep 18 milestone.
 *
 * WHAT A REVIEWER IS DOING HERE
 *
 * Approving a reply on behalf of a business, to a person the business knows and
 * they do not. Before this existed, the screen showed one message — the one the
 * draft answers — with no way to tell whether the customer had already asked
 * the same thing twice, whether the shop had answered an hour ago, or whether
 * the draft repeats something already said. The reviewer had the AI's guess and
 * no context to judge it against, which is the wrong side of a
 * human-in-the-loop product to be short of information on.
 *
 * TWO THINGS THIS SAYS OUT LOUD RATHER THAN HIDING
 *
 *   * Older messages exist but are not shown. A thread that silently stops is
 *     one a reviewer reads as complete.
 *   * The message being answered is not in the window. Rare, and invisible
 *     unless stated — the reviewer would read a history that does not contain
 *     the message the draft is replying to.
 *
 * THE HANDOFF CONTROL LIVES HERE, NOT ON THE INBOX
 *
 * Deciding that a conversation needs a person is a decision made while reading
 * it, not while scanning a list. And it is not a label: `process_inbound_message`
 * enqueues a draft only for conversations whose status is `open`, so handing
 * off **stops the AI drafting replies to this customer** until someone returns
 * it. The button says so, and the screen says so while it is off.
 *
 * NO SEND CONTROL, HERE LEAST OF ALL. This is the screen that most looks like a
 * chat, which is exactly why Amendment 7 is asserted against it by name in
 * `ConversationThread.test.tsx`. Nothing in TuGPT sends.
 */

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/provider';
import { formatDateTime } from '@/i18n';
import { apiErrorText } from '@/lib/draft-api/error-text';
import type { ConversationThread as Thread } from '@/lib/draft-api/types';

export function ConversationThread({ draftId }: { draftId: string }) {
  const t = useT();
  const [thread, setThread] = useState<Thread | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Retry. A counter and not a boolean: the effect must re-run every
  // time the button is pressed, and setting a value to itself is a no-op React
  // optimises away — the exact bug the draft inbox shipped with for months.
  const [attempt, setAttempt] = useState(0);
  const [handoffPending, setHandoffPending] = useState(false);
  /**
   * Kept apart from `error` on purpose.
   *
   * A handoff attempt always reloads the thread afterwards, and a successful
   * reload sets `error` back to null. Writing a refusal into `error` therefore
   * put the message on screen and wiped it a few milliseconds later: the
   * reviewer clicked "hand off", it was refused, and the screen went back to
   * looking normal. They would have walked away believing the AI had been
   * stopped for that customer while it had not. Caught by T20.
   */
  const [handoffError, setHandoffError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/v1/drafts/${draftId}/thread`);
        const data = await res.json();
        if (cancelled) return;

        if (!res.ok) {
          setError(apiErrorText(t, data));
          setThread(null);
        } else {
          setThread(data.thread as Thread);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError(t('drafts.thread.loadFailed'));
          setThread(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, attempt]);

  /**
   * Turn AI drafting off for this conversation, or back on.
   *
   * `expectedStatus` is what this screen is showing. If somebody else changed
   * it since the page loaded the server refuses, and the reviewer is told
   * rather than silently overriding a colleague's decision — which, in this
   * direction, means silently turning the AI back on for a customer somebody
   * deliberately took it off.
   */
  const setHandoff = useCallback(
    async (needsHuman: boolean, expectedStatus: string, conversationId: string) => {
      setHandoffPending(true);
      setHandoffError(null);
      try {
        const res = await fetch(`/api/v1/conversations/${conversationId}/handoff`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-tugpt-csrf': '1' },
          body: JSON.stringify({ needsHuman, expectedStatus }),
        });
        if (!res.ok) {
          setHandoffError(apiErrorText(t, await res.json()));
        }
      } catch {
        setHandoffError(t('thread.handoffFailed'));
      } finally {
        setHandoffPending(false);
        // Reload either way. On a conflict the screen was stale — which is the
        // reason the request was refused — so leaving it stale would send the
        // same wrong `expectedStatus` on the next click.
        setAttempt((n) => n + 1);
      }
    },
    [t]
  );

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    setHandoffError(null);
    setAttempt((n) => n + 1);
  }, []);

  return (
    <section className="mb-6">
      <h2 className="mb-2 text-lg font-semibold text-zinc-800">{t('drafts.thread.heading')}</h2>

      {loading && <p className="text-sm text-zinc-500">{t('drafts.thread.loading')}</p>}

      {!loading && error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">{error}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-2 rounded border border-red-300 px-3 py-1 text-sm font-medium text-red-700 transition hover:bg-red-100"
          >
            {t('drafts.thread.retry')}
          </button>
        </div>
      )}

      {!loading && !error && thread && (
        <div className="rounded-lg border border-zinc-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2 text-xs text-zinc-500">
            {thread.contact_display && <span>{thread.contact_display}</span>}
            <span>
              {t('drafts.detail.conversationStatus', {
                status: t(`drafts.conversation.${thread.status}`),
              })}
            </span>
          </div>

          {/*
            Stated in words, not implied by a status chip. "needs_human" is a
            vocabulary word; "the AI is not drafting replies for this
            conversation" is what actually happened.
          */}
          {thread.status === 'needs_human' && (
            <p className="border-b border-sky-200 bg-sky-50 px-4 py-2 text-xs text-sky-900">
              {t('thread.handedOff')}
            </p>
          )}

          {/*
            No control on a closed conversation: the RPC refuses that
            transition (P3C05), and a button whose only outcome is an error
            teaches a reviewer to stop reading error messages.
          */}
          {thread.status !== 'closed' && (
            <div className="border-b border-zinc-200 px-4 py-2">
              <button
                type="button"
                disabled={handoffPending}
                onClick={() =>
                  setHandoff(
                    thread.status !== 'needs_human',
                    thread.status,
                    thread.conversation_id
                  )
                }
                className="rounded border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-50"
              >
                {thread.status === 'needs_human'
                  ? t('thread.returnToAi')
                  : t('thread.handoff')}
              </button>
            </div>
          )}

          {/*
            Outside the block above, not inside it. If the conversation was
            closed by someone else between the click and the reload, the button
            disappears — and an error rendered beside it would disappear with
            it, which is the same silent failure T20 exists to prevent, just
            one step further along.

            role="alert" because this appears in response to a click the
            reviewer has already looked away from, and what it says is "the
            thing you just did did not happen".
          */}
          {handoffError && (
            <p role="alert" className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
              {handoffError}
            </p>
          )}

          {thread.has_more && (
            <p className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-xs text-zinc-500">
              {t('drafts.thread.olderHidden', { count: String(thread.messages.length) })}
            </p>
          )}

          {!thread.source_in_window && (
            <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
              {t('drafts.thread.sourceOutOfWindow')}
            </p>
          )}

          {thread.messages.length === 0 ? (
            <p className="px-4 py-6 text-sm text-zinc-500">{t('drafts.thread.empty')}</p>
          ) : (
            <ol className="divide-y divide-zinc-100">
              {thread.messages.map((m) => (
                <li
                  key={m.id}
                  // The message being answered is marked with a border and a
                  // label, not colour alone — a reviewer who cannot distinguish
                  // amber from white still needs to find it, and it is the one
                  // thing on this screen they are here to find.
                  className={`px-4 py-3 ${m.is_source ? 'border-l-4 border-l-amber-400 bg-amber-50' : ''}`}
                >
                  <div className="mb-1 flex flex-wrap items-baseline gap-x-3 text-xs text-zinc-500">
                    <span className="font-medium text-zinc-700">
                      {m.direction === 'inbound'
                        ? t('drafts.thread.fromCustomer')
                        : t('drafts.thread.fromBusiness')}
                    </span>
                    <span>{formatDateTime(m.created_at, t.locale)}</span>
                    {m.is_source && (
                      <span className="rounded bg-amber-200 px-2 py-0.5 font-medium text-amber-900">
                        {t('drafts.thread.sourceLabel')}
                      </span>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-zinc-800">
                    {m.body || <span className="italic text-zinc-400">{t('drafts.thread.noBody')}</span>}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
