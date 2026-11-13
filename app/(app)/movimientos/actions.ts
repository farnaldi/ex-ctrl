'use server';
import { revalidatePath } from 'next/cache';
import * as E from '@/lib/transaction-edits';
import { requireWebCtx } from '@/lib/session';

// Thin wrappers: session → lib/transaction-edits (zod + domain fn) → revalidate. Each returns the op id for undo.
// 'layout' revalidates /movimientos and /movimientos/[id] (the list behind the drawer and the detail page).

async function run<T>(fn: (ctx: Awaited<ReturnType<typeof requireWebCtx>>['ctx']) => Promise<E.EditResult<T>>) {
  const { ctx } = await requireWebCtx();
  const r = await fn(ctx);
  if (r.ok) revalidatePath('/movimientos', 'layout');
  return r;
}

export async function updateTx(input: unknown) {
  return run((ctx) => E.updateTx(ctx, input));
}

export async function setTags(input: unknown) {
  return run((ctx) => E.setTags(ctx, input));
}

export async function categorizeTx(input: unknown) {
  return run((ctx) => E.categorizeTx(ctx, input));
}

export async function applyToMerchant(input: unknown) {
  return run((ctx) => E.applyToMerchant(ctx, input));
}

export async function undoOp(opId: string) {
  return run((ctx) => E.undoOp(ctx, opId));
}
