// Control Center labs — these tests prove the labs run production
// code and tell the truth about their mode: runnable labs return real
// outputs, blocked labs return blocked (never fabricated success).

import { describe, expect, it } from 'vitest';
import {
  labAppointments,
  labBlocked,
  labDeliveryReceipts,
  labFaqRetrieval,
  labGroundedPrompt,
  labOverview,
  labWhatsAppInbound,
} from './labs';

describe('faq retrieval lab', () => {
  it('selects the matching entry through the production function', () => {
    const result = labFaqRetrieval({ question: '¿Cuál es el horario?' });
    expect(result.mode).toBe('real-in-process');
    const output = result.output as { selected: { question: string }[] };
    expect(output.selected.length).toBeGreaterThan(0);
    expect(output.selected[0].question).toContain('horario');
  });

  it('returns an empty selection for an unrelated question', () => {
    const result = labFaqRetrieval({ question: 'quantum entanglement' });
    const output = result.output as { selected: unknown[] };
    expect(output.selected).toHaveLength(0);
  });
});

describe('grounded prompt lab', () => {
  it('renders the matched entries in the worker block format', () => {
    const result = labGroundedPrompt({ question: '¿Cuál es el horario?' });
    const output = result.output as { block: string };
    expect(output.block).toContain('horario');
  });

  it('says plainly when nothing matches', () => {
    const result = labGroundedPrompt({ question: 'quantum entanglement' });
    const output = result.output as { block: string };
    expect(output.block).toContain('no entries matched');
  });
});

describe('whatsapp inbound lab', () => {
  it('extracts the message event from a synthetic Meta payload', () => {
    const result = labWhatsAppInbound({});
    const output = result.output as {
      events: { bodyText: string; providerMessageId: string }[];
    };
    expect(output.events).toHaveLength(1);
    expect(output.events[0].bodyText).toContain('horario');
    expect(output.events[0].providerMessageId).toBe('wamid.test123');
  });

  it('never claims a send happened', () => {
    const result = labWhatsAppInbound({});
    expect(result.summary).toContain('no message was sent');
  });
});

describe('delivery receipts lab', () => {
  it('maps a read receipt onto the display state with receipt times', () => {
    const result = labDeliveryReceipts({ currentStatus: 'sent', receipt: 'read' });
    const output = result.output as {
      statuses: { status: string }[];
      view: { deliveredAt: string | null; readAt: string | null };
    };
    expect(output.statuses[0].status).toBe('read');
    expect(output.view.deliveredAt).not.toBeNull();
    expect(output.view.readAt).not.toBeNull();
  });
});

describe('appointments lab', () => {
  it('finds slots through the real service and round-trips a stored request', async () => {
    const result = await labAppointments({});
    expect(result.mode).toBe('simulated-provider');
    const output = result.output as {
      availability: { ok: boolean; slots: unknown[] };
      readBackFound: boolean;
    };
    expect(output.availability.ok).toBe(true);
    expect(output.availability.slots.length).toBeGreaterThan(0);
    expect(output.readBackFound).toBe(true);
    expect(result.summary).toContain('SIMULATED');
  });
});

describe('blocked labs', () => {
  it('report blocked with the reason, never a fabricated success', () => {
    const result = labBlocked('voice-transcription', 'No Gladia key here.');
    expect(result.mode).toBe('blocked');
    expect(result.summary).toContain('No Gladia key here.');
  });
});

describe('overview lab', () => {
  it('reports the kill switch OFF (the code default)', () => {
    expect(labOverview().killSwitch).toBe(false);
  });

  it('reports env presence as booleans, never values', () => {
    const presence = labOverview().envPresence;
    for (const value of Object.values(presence)) {
      expect(typeof value).toBe('boolean');
    }
  });
});
