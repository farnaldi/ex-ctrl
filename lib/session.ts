import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Ctx } from '@/src/core/db';
import { auth, resolveUser } from './auth';

/** The signed-in person as a domain context (web writes are audited as 'user'). Redirects to /login otherwise. */
export async function requireWebCtx(): Promise<{ ctx: Ctx; email: string }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || !(await resolveUser(session.user.id))) redirect('/login');
  return { ctx: { userId: session.user.id, actor: 'user', source: 'web' }, email: session.user.email };
}
