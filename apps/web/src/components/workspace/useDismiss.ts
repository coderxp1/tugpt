'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Closes a popover on Escape (focus goes back to its trigger) or on a pointer press outside it.
 * Shared by the model, agent and profile menus so they all behave the same way.
 */
export function useDismiss(open: boolean, root: RefObject<HTMLElement | null>, close: (restoreFocus: boolean) => void) {
  useEffect(() => {
    if (!open) return;
    function key(e: KeyboardEvent) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } }
    function press(e: PointerEvent | MouseEvent) { if (root.current && !root.current.contains(e.target as Node)) close(false); }
    document.addEventListener('keydown', key, true);
    document.addEventListener('mousedown', press);
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('mousedown', press); };
  }, [open, root, close]);
}
