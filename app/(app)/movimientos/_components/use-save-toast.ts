'use client';
import { useCallback } from 'react';
import { useToast } from '@/components/toast';
import type { EditResult } from '@/lib/transaction-edits';
import { applyToMerchant, undoOp } from '../actions';

export type CategoryChange = { merchant: string; from: string | null; to: string };

/**
 * Feedback after an edit: "Guardado · Deshacer", plus "Aplicar a todo <comercio>" when the category of a row with
 * a merchant changed (moves the merchant's other rows in the old category, its rules and default: future imports follow).
 */
export function useSaveToast() {
  const toast = useToast();

  const undo = useCallback(
    async (opId: string) => {
      const r = await undoOp(opId);
      toast(r.ok ? { message: 'Cambio deshecho.' } : { message: r.error, tone: 'error' });
    },
    [toast],
  );

  const apply = useCallback(
    async (c: CategoryChange) => {
      const r = await applyToMerchant({ merchant: c.merchant, from_category: c.from, to_category: c.to });
      if (!r.ok) return toast({ message: r.error, tone: 'error' });
      const rows = r.rowsUpdated === 1 ? '1 movimiento más' : `${r.rowsUpdated} movimientos más`;
      toast({
        message: `${c.merchant} → ${c.to}: ${rows}${r.rulesUpdated ? ` y ${r.rulesUpdated === 1 ? '1 regla' : `${r.rulesUpdated} reglas`}` : ''}. Los próximos imports también.`,
        actions: [{ label: 'Deshacer', onClick: () => undo(r.opId) }],
      });
    },
    [toast, undo],
  );

  return useCallback(
    (r: EditResult, opts: { message?: string; categoryChange?: CategoryChange | null } = {}) => {
      if (!r.ok) return toast({ message: r.error, tone: 'error' });
      const c = opts.categoryChange;
      toast({
        message: opts.message ?? 'Guardado.',
        actions: [
          { label: 'Deshacer', onClick: () => undo(r.opId) },
          ...(c ? [{ label: `Aplicar a todo ${c.merchant}`, onClick: () => apply(c) }] : []),
        ],
      });
    },
    [toast, undo, apply],
  );
}
