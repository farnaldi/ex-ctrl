'use server';
import { revalidatePath } from 'next/cache';
import { disconnectAgent } from '@/lib/auth';
import { requireWebCtx } from '@/lib/session';
import { createApiToken, revokeApiToken } from '@/src/core/tokens';

export async function createTokenAction(_: unknown, form: FormData) {
  const { ctx } = await requireWebCtx();
  const name = String(form.get('name') ?? '');
  const readOnly = form.get('read_only') === 'on';
  const days = Number(form.get('expires_days') ?? 0);
  try {
    const t = await createApiToken(ctx, { name, readOnly, expiresInDays: days > 0 ? days : null });
    revalidatePath('/tokens');
    return { ok: true as const, token: t.token, name: t.name };
  } catch (e) {
    const msg = (e as Error).message;
    return { ok: false as const, error: /unique/i.test(msg) ? 'Ya existe un token con ese nombre' : msg };
  }
}

export async function revokeTokenAction(form: FormData) {
  const { ctx } = await requireWebCtx();
  await revokeApiToken(ctx, Number(form.get('id')));
  revalidatePath('/tokens');
}

export async function disconnectAgentAction(form: FormData) {
  const { ctx } = await requireWebCtx();
  await disconnectAgent(ctx.userId, String(form.get('id')));
  revalidatePath('/tokens');
}
