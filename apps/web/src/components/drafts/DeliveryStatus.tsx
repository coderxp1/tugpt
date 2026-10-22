'use client';

// Outbound delivery status for an approved draft (migration
// 20261022000001 + 20261022000003).
//
// The badge vocabulary is the API's display vocabulary
// (lib/draft-api/delivery-status): queued, sending, sent, failed,
// rejected. The panel fetches GET /api/v1/drafts/:id/delivery and
// renders nothing when the draft has no delivery — a pending or
// rejected draft has nothing to report, and absence must not be
// dressed up as a state.
//
// There is deliberately no retry/send control here. Delivery is a
// consequence of approval, executed by the worker under the
// whatsapp_integration gate; the reviewer's controls stay Approve /
// Edit / Reject.

import { useState, useEffect } from 'react';
import type { DeliveryView } from '@/lib/draft-api/delivery-status';
import { useT } from '@/i18n/provider';

const BADGE_STYLES: Record<DeliveryView['status'], string> = {
  queued: 'bg-blue-100 text-blue-800',
  sending: 'bg-blue-100 text-blue-800',
  sent: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  rejected: 'bg-red-100 text-red-800',
};

export function DeliveryBadge({
  delivery,
}: {
  delivery: DeliveryView | null | undefined;
}) {
  const t = useT();
  if (!delivery) return null;
  return (
    <span
      className={`rounded-full px-2 py-1 text-xs font-medium ${BADGE_STYLES[delivery.status]}`}
    >
      {t(`drafts.delivery.${delivery.status}`)}
    </span>
  );
}

export function DeliveryStatusPanel({
  draftId,
  refreshKey,
}: {
  draftId: string;
  refreshKey?: number;
}) {
  const t = useT();
  const [delivery, setDelivery] = useState<DeliveryView | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/drafts/${draftId}/delivery`);
        if (!res.ok) return;
        const data = (await res.json()) as { delivery: DeliveryView | null };
        if (!cancelled) {
          setDelivery(data.delivery);
          setLoaded(true);
        }
      } catch {
        // A failed status read shows nothing rather than an error
        // state the reviewer cannot act on; the draft itself loaded.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftId, refreshKey]);

  if (!loaded || !delivery) return null;

  return (
    <div className="rounded-lg border border-zinc-200 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-900">
          {t('drafts.delivery.title')}
        </h3>
        <DeliveryBadge delivery={delivery} />
      </div>
      {(delivery.providerMessageId || delivery.attempts > 0) && (
        <dl className="mt-2 space-y-1 text-xs text-zinc-500">
          {delivery.providerMessageId && (
            <div className="flex gap-2">
              <dt>{t('drafts.delivery.providerId')}</dt>
              <dd className="font-mono">{delivery.providerMessageId}</dd>
            </div>
          )}
          {delivery.attempts > 0 && (
            <div className="flex gap-2">
              <dt>{t('drafts.delivery.attempts')}</dt>
              <dd>{delivery.attempts}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
