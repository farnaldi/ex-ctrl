'use client';
import { useCallback } from 'react';
import { useToast } from '@/components/toast';
import type { EditResult } from '@/lib/transaction-edits';
import { applyToMerchant, undoOp } from '../actions';

export type CategoryChange = { merchant: string; from: string | null; to: string };

const NETWORK_ERROR = 'No se pudo guardar: sin conexión con el servidor. Probá de nuevo.';

/**
 * Calls a server action and turns a rejected call (network down, a deploy mid-request) into an error result,
 * so it shows as a toast instead of escaping the transition into the error boundary and replacing the page.
 */
export async function safely<T>(call: () => Promise<EditResult<T>>): Promise<EditResult<T>> {
  try {
    return await call();
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
}

/** Offer "apply to the whole merchant" only for a real category change (names match case-insensitively). */
export function categoryChange(merchant: string | null, from: string | null, to: string | null): CategoryChange | null {
  if (!merchant || !to || (from ?? '').toLowerCase() === to.toLowerCase()) return null;
  return { merchant, from, to };
}

/**
 * Feedback after an edit: "Guardado · Deshacer", plus "Aplicar a todo <comercio>" when the category of a row with
 * a merchant changed (moves the merchant's other rows in the old category, and its rules/default if they were in it).
 */
export function useSaveToast() {
  const toast = useToast();

  const undo = useCallback(
    async (opId: string) => {
      const r = await safely(() => undoOp(opId));
      toast(r.ok ? { message: 'Cambio deshecho.' } : { message: r.error, tone: 'error' });
    },
    [toast],
  );

  const apply = useCallback(
    async (c: CategoryChange) => {
      const r = await safely(() => applyToMerchant({ merchant: c.merchant, from_category: c.from, to_category: c.to }));
      if (!r.ok) return toast({ message: r.error, tone: 'error' });
      const rows = r.rowsUpdated === 1 ? '1 movimiento más' : `${r.rowsUpdated} movimientos más`;
      const rules = r.rulesUpdated ? ` y ${r.rulesUpdated === 1 ? '1 regla' : `${r.rulesUpdated} reglas`}` : '';
      const future = r.rulesUpdated || r.defaultUpdated ? ' Los próximos imports también.' : '';
      toast({
        message: `${c.merchant} → ${c.to}: ${rows}${rules}.${future}`,
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
