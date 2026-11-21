// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { PendingUploads } from '../PendingUploads';
beforeEach(()=>localStorage.clear());afterEach(cleanup);
it('shows only this owner and organization pending attempts without names or fingerprints',()=>{localStorage.setItem('tugpt-upload:org:user:private:hash-secret','pending');localStorage.setItem('tugpt-upload:other:user:private:other-hash','pending');render(<PendingUploads scope="org:user"/>);expect(screen.getByRole('status').textContent).toContain('1 upload attempts');expect(screen.getByRole('status').textContent).not.toContain('hash-secret');});
it('updates when a saved copy is reconciled in the current tab',()=>{localStorage.setItem('tugpt-upload:org:user:private:hash','pending');render(<PendingUploads scope="org:user"/>);act(()=>{localStorage.removeItem('tugpt-upload:org:user:private:hash');window.dispatchEvent(new Event('tugpt-upload-change'));});expect(screen.queryByRole('status')).toBeNull();});
