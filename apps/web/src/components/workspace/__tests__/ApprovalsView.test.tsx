// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ApprovalRecord } from '@/lib/workspace-data/contracts';
import { ApprovalsView } from '../ApprovalsView';
import { fakeApi, iso } from './fake-api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ME = 'u0000000-0000-4000-8000-000000000001';
const record = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id: 'r0000000-0000-4000-8000-000000000001', source: 'request', status: 'pending', threadId: null,
  requestedBy: { id: ME, name: 'Clara Vidal' }, decidedBy: null, connectionId: 'c1', endpointName: 'Shop',
  capability: 'orders.refund', permissionClass: 'financial', argumentsSha256: 'a'.repeat(64),
  argumentsPreview: [{ path: 'orderId', value: 'A-1009', redacted: false, truncated: false }, { path: 'card', value: '', redacted: true, truncated: false }],
  reason: 'Customer was charged twice', decisionNote: null, decidedAt: null, toolApprovalId: null, approvalExpiresAt: null,
  usedAt: null, revokedAt: null, createdAt: iso(3), expiresAt: iso(-60), ...over,
});

describe('ApprovalsView', () => {
  it('says the feature is unavailable when the approvals API is not deployed', async () => {
    fakeApi({});
    render(<ApprovalsView canDecide userId={ME} />);
    expect(await screen.findByText('Approvals: not available in this workspace yet.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('admins see the organization’s pending requests with a redacted preview, and approve after confirming', async () => {
    const api = fakeApi({
      'GET /api/v1/approvals': ({ url }) => ({ body: { approvals: url.searchParams.get('scope') === 'org' ? [record()] : [], nextCursor: null } }),
      'POST /api/v1/approvals/:id': () => ({ body: { id: record().id, action: 'approve', changed: true, toolApprovalId: 't1', approvalExpiresAt: iso(-30) } }),
    });
    render(<ApprovalsView canDecide userId="someone-else" />);
    const item = (await screen.findByRole('heading', { level: 2, name: 'Shop · orders.refund' })).closest('li')!;
    expect(api.calls[0].search).toBe('?scope=org&status=pending&limit=25');
    expect(within(item).getByText('Financial')).toBeTruthy();
    expect(within(item).getByText('Customer was charged twice')).toBeTruthy();
    expect(within(item).getByText('Hidden')).toBeTruthy();
    expect(within(item).queryByRole('button', { name: 'Cancel request' })).toBeNull();

    fireEvent.click(within(item).getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Approve this action?' });
    expect(within(dialog).getByText('A-1009')).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText('30 min'));
    fireEvent.change(within(dialog).getByLabelText(/^Note/), { target: { value: 'Refund confirmed with the bank' } });
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved: Shop · orders.refund.')).toBeTruthy();
    const post = api.calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ action: 'approve', ttlSeconds: 1800, note: 'Refund confirmed with the bank' });
    expect(post?.headers['x-tugpt-csrf']).toBe('1');
  });

  it('members see their own requests, can cancel a pending one, and cannot approve', async () => {
    const api = fakeApi({
      'GET /api/v1/approvals': () => ({ body: { approvals: [record(), record({ id: 'r2', status: 'rejected', decidedBy: { id: 'x', name: 'Anna Ortiz' }, decisionNote: 'Use the refund form', decidedAt: iso(1) })], nextCursor: null } }),
      'POST /api/v1/approvals/:id': () => ({ body: { id: record().id, action: 'cancel', changed: true, toolApprovalId: null, approvalExpiresAt: null } }),
    });
    render(<ApprovalsView canDecide={false} userId={ME} />);
    await screen.findAllByRole('heading', { level: 2, name: 'Shop · orders.refund' });
    expect(api.calls[0].search).toBe('?scope=mine&limit=25');
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getAllByText('Rejected').some((el) => el.tagName === 'SPAN')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel request' }));
    expect(await screen.findByText('Request cancelled: Shop · orders.refund.')).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({ action: 'cancel' });
  });

  it('a decision another admin already made is explained, not hidden', async () => {
    fakeApi({
      'GET /api/v1/approvals': () => ({ body: { approvals: [record()], nextCursor: null } }),
      'POST /api/v1/approvals/:id': () => ({ status: 409, body: { error: 'ALREADY_DECIDED' } }),
    });
    render(<ApprovalsView canDecide userId="x" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Reject this request?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('This request has already been decided.');
  });
});
