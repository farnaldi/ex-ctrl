import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import type { Ctx } from '@/src/core/db';
import { auth, resolveUser } from './auth';

/**
 * The signed-in person as a domain context (web writes are audited as 'user'). Redirects to /login otherwise.
 * Memoized per request with React cache(): the layout and the page share one session lookup instead of two.
 */
export const requireWebCtx = cache(async (): Promise<{ ctx: Ctx; email: string }> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || !(await resolveUser(session.user.id))) redirect('/login');
  return { ctx: { userId: session.user.id, actor: 'user', source: 'web' }, email: session.user.email };
});
