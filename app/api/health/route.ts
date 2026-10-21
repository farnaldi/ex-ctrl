import { pool } from '@/src/core/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await pool().query('select 1');
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
