// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog';
afterEach(cleanup);

describe('ConfirmDialog keyboard behaviour', () => {
  it('starts on Cancel, keeps Tab inside the dialog in both directions, and closes on Escape', () => {
    const onClose = vi.fn();
    render(<ConfirmDialog title="Remove Docs?" confirmLabel="Remove server" busyLabel="Removing…" onConfirm={async () => null} onClose={onClose}><p>Gone for good.</p></ConfirmDialog>);
    const cancel = screen.getByRole('button', { name: 'Cancel' }); const remove = screen.getByRole('button', { name: 'Remove server' });
    expect(document.activeElement).toBe(cancel);
    remove.focus(); fireEvent.keyDown(document, { key: 'Tab' }); expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(remove);
    expect(screen.getByRole('alertdialog').getAttribute('aria-modal')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' }); expect(onClose).toHaveBeenCalledOnce();
  });
});
