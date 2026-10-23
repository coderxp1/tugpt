/**
 * @file appointments-handler.test.ts
 * @description Boundary tests for the appointments request handler: the
 * payload validation matrix (refused before any I/O), the happy path
 * through a real AppointmentsService (in-memory store + mock provider),
 * provider-outcome passthrough, and infrastructure-failure mapping.
 */

import { describe, it, expect } from 'vitest';
import {
  AppointmentsService,
  AvailabilityService,
  InMemoryAppointmentStore,
  MockBehaviour,
  MockCalendarAvailabilityProvider,
} from '@tugpt/appointments';
import {
  createAppointmentRequestHandler,
} from '../src/appointments-handler';
import type {
  AppointmentsDeps,
  OrganizationAppointments,
} from '../src/appointments-deps-factory';

const ORG = '11111111-2222-3333-4444-555555555555';

function depsWith(
  behaviour: MockBehaviour,
  store: InMemoryAppointmentStore
): AppointmentsDeps {
  const provider = new MockCalendarAvailabilityProvider({ behaviour });
  const runtime: OrganizationAppointments = {
    store,
    service: new AppointmentsService({
      store,
      availability: new AvailabilityService(provider),
      timeZoneConfig: {
        organizationTimeZone: 'Europe/Madrid',
        platformDefaultTimeZone: 'UTC',
      },
    }),
    freeBusyEnabled: true,
    timeZoneConfig: {
      organizationTimeZone: 'Europe/Madrid',
      platformDefaultTimeZone: 'UTC',
    },
  };
  return {
    store,
    forOrganization: async () => runtime,
  };
}

function validPayload(): Record<string, unknown> {
  return {
    organizationId: ORG,
    idempotencyKey: 'msg-1',
    windowStart: '2026-01-15T09:00:00.000Z',
    windowEnd: '2026-01-15T11:00:00.000Z',
    durationMinutes: 60,
    calendarId: 'cal-1',
  };
}

describe('appointments handler — happy path and passthrough', () => {
  it('answers a valid payload with recorded suggestions', async () => {
    const store = new InMemoryAppointmentStore();
    const handle = createAppointmentRequestHandler(
      depsWith(MockBehaviour.AVAILABLE, store)
    );

    const result = await handle(validPayload());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.request.organizationId).toBe(ORG);
    expect(result.request.timeZone).toBe('Europe/Madrid');
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('passes a provider failure reason through verbatim', async () => {
    const store = new InMemoryAppointmentStore();
    const handle = createAppointmentRequestHandler(
      depsWith(MockBehaviour.NOT_CONFIGURED, store)
    );

    const result = await handle(validPayload());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('NOT_CONFIGURED');
  });

  it('maps a factory failure to UNAVAILABLE without internal detail', async () => {
    const deps: AppointmentsDeps = {
      store: new InMemoryAppointmentStore(),
      forOrganization: async () => {
        throw new Error('pg: connection to 10.0.0.5 refused, password=secret');
      },
    };
    const handle = createAppointmentRequestHandler(deps);

    const result = await handle(validPayload());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('UNAVAILABLE');
    expect(result.detail).not.toContain('10.0.0.5');
    expect(result.detail).not.toContain('password');
  });
});

describe('appointments handler — validation refuses before any I/O', () => {
  it.each([
    ['a non-object payload', 'not-an-object'],
    ['an array payload', []],
    ['a non-UUID organizationId', { ...validPayload(), organizationId: 'org-1' }],
    ['an empty idempotencyKey', { ...validPayload(), idempotencyKey: '' }],
    ['an unparseable windowStart', { ...validPayload(), windowStart: 'next Tuesday' }],
    ['a missing windowEnd', { ...validPayload(), windowEnd: undefined }],
    ['a zero duration', { ...validPayload(), durationMinutes: 0 }],
    ['an over-long duration', { ...validPayload(), durationMinutes: 481 }],
    ['a fractional duration', { ...validPayload(), durationMinutes: 59.5 }],
    ['an empty calendarId', { ...validPayload(), calendarId: '' }],
    ['a non-UUID contactId', { ...validPayload(), contactId: 'contact-9' }],
  ])('refuses %s', async (_label, payload) => {
    const store = new InMemoryAppointmentStore();
    const handle = createAppointmentRequestHandler(
      depsWith(MockBehaviour.AVAILABLE, store)
    );

    const result = await handle(payload);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('INVALID_REQUEST');
  });

  it('does not resolve the factory for an invalid payload', async () => {
    let resolved = 0;
    const deps: AppointmentsDeps = {
      store: new InMemoryAppointmentStore(),
      forOrganization: async () => {
        resolved += 1;
        throw new Error('must not be called');
      },
    };
    const handle = createAppointmentRequestHandler(deps);

    await handle({ ...validPayload(), organizationId: 'nope' });

    expect(resolved).toBe(0);
  });
});
