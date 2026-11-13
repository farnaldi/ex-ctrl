'use client';
import { useOptimistic, useRef, useState, useTransition } from 'react';
import { categorizeTx } from '../actions';
import { useSaveToast } from './use-save-toast';

/**
 * Category cell of the list (desktop only; the column is hidden on phones). Click to edit: Enter or leaving the
 * field saves, Esc cancels. Shows the new value at once (optimistic) and the toast offers undo / apply to the merchant.
 */
export function CategoryCell({ id, category, merchant, listId }: { id: number; category: string | null; merchant: string | null; listId: string }) {
  const [shown, setShown] = useOptimistic(category);
  const [editing, setEditing] = useState(false);
  const [, startTransition] = useTransition();
  const cancelled = useRef(false);
  const saved = useSaveToast();

  function commit(raw: string) {
    setEditing(false);
    const next = raw.trim() || null;
    if (cancelled.current || next === category) return;
    startTransition(async () => {
      setShown(next);
      const r = await categorizeTx({ transaction_id: id, category: next ?? '' });
      saved(r, {
        message: next ? `Categoría: ${next}.` : 'Categoría quitada.',
        categoryChange: next && merchant ? { merchant, from: category, to: next } : null,
      });
    });
  }

  if (editing)
    return (
      <input
        autoFocus
        defaultValue={shown ?? ''}
        list={listId}
        aria-label="Categoría"
        className="field -my-1 py-1"
        autoComplete="off"
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
          if (e.key === 'Escape') { e.preventDefault(); cancelled.current = true; e.currentTarget.blur(); }
        }}
        onFocus={() => { cancelled.current = false; }}
        onBlur={(e) => commit(e.currentTarget.value)}
      />
    );

  return (
    <button type="button" onClick={() => setEditing(true)} title="Cambiar categoría" className="-mx-1 rounded px-1 text-left hover:bg-line/60">
      {shown ?? <span className="text-muted">—</span>}
    </button>
  );
}
