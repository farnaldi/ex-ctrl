/**
 * What the /movimientos server actions do, minus the Next.js parts (session, revalidation), so tests can call it
 * with a plain Ctx. Every edit is parsed with the same zod schemas as the MCP tools and goes through the domain
 * functions, so web edits are audited and undoable exactly like the agent's. Errors come back as values, not throws:
 * the client shows them in the toast.
 */
import * as z from 'zod';
import { dbErrorMessage, type Ctx } from '../src/core/db.ts';
import { recategorizeMerchant, saveTransaction, undo, updateTransaction } from '../src/core/finance.ts';
import * as S from '../src/core/schemas.ts';

export type EditResult<T = object> = ({ ok: true; opId: string } & T) | { ok: false; error: string };

const TxId = z.number().int().positive();

/** Field edits + full tag set from the drawer / detail form: one operation, one undo. */
export async function updateTx(ctx: Ctx, input: unknown) {
  return attempt(S.SaveTransaction, input, async (i) => {
    const r = await saveTransaction(ctx, i);
    return { opId: r.op_id, transaction: r.transaction };
  });
}

/** Replace the row's tags. */
export async function setTags(ctx: Ctx, input: unknown) {
  return attempt(z.object({ transaction_id: TxId, tags: S.SaveTransaction.shape.tags.unwrap() }), input, async (i) => {
    const r = await saveTransaction(ctx, { transaction_id: i.transaction_id, tags: i.tags });
    return { opId: r.op_id, transaction: r.transaction };
  });
}

/** Inline category edit in the table (created if missing; empty clears it). */
export async function categorizeTx(ctx: Ctx, input: unknown) {
  const schema = z.object({ transaction_id: TxId, category: z.string().trim().max(80).transform((v) => v || null) });
  return attempt(schema, input, async (i) => {
    const r = await updateTransaction(ctx, { transaction_id: i.transaction_id, category: i.category });
    return { opId: r.op_id, transaction: r.transaction };
  });
}

/** "Aplicar a todo el comercio" after a category change. */
export async function applyToMerchant(ctx: Ctx, input: unknown) {
  return attempt(S.MerchantCategory, input, async (i) => {
    const r = await recategorizeMerchant(ctx, i);
    return { opId: r.op_id, rowsUpdated: r.rows_updated, rulesUpdated: r.rules_updated };
  });
}

export async function undoOp(ctx: Ctx, input: unknown) {
  return attempt(z.string().uuid(), input, async (opId) => {
    const r = await undo(ctx, opId);
    return { opId: r.op_id, rowsReverted: r.rows_reverted };
  });
}

async function attempt<I, T extends object>(schema: z.ZodType<I>, input: unknown, fn: (i: I) => Promise<{ opId: string } & T>): Promise<EditResult<T>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: `Datos inválidos: ${parsed.error.issues.map((x) => `${x.path.join('.') || 'valor'} ${x.message}`).join('; ')}` };
  try {
    return { ok: true, ...(await fn(parsed.data)) };
  } catch (e) {
    return { ok: false, error: friendly(dbErrorMessage(e)) };
  }
}

/** The domain speaks English to the agent; the web shows Spanish for the common cases. */
function friendly(msg: string) {
  if (/^transaction \d+ not found/.test(msg)) return 'No se encontró el movimiento.';
  if (/^operation .* not found/.test(msg)) return 'No se encontró el cambio a deshacer.';
  if (/already undone/.test(msg)) return 'Ese cambio ya se deshizo.';
  if (/changed after this operation/.test(msg)) return 'No se puede deshacer: hubo cambios posteriores en esos datos (deshacelos primero).';
  if (/^merchant .* not found/.test(msg)) return 'No se encontró el comercio.';
  return msg;
}
