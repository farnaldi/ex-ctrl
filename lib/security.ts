/**
 * Small in-process guards for the public surface. The app runs as one instance; with several instances,
 * move these counters to Postgres or Redis.
 */

// ---- per-account sign-in lockout: complements Better Auth's per-IP rate limit (an attacker with many IPs)
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 10;
const fails = new Map<string, number[]>(); // email -> failure timestamps

const recent = (email: string) => (fails.get(email) ?? []).filter((t) => Date.now() - t < FAIL_WINDOW_MS);

export function signInLocked(email: string): boolean {
  return recent(email.toLowerCase()).length >= MAX_FAILS;
}
export function recordSignIn(email: string, ok: boolean) {
  const key = email.toLowerCase();
  if (ok) fails.delete(key);
  else fails.set(key, [...recent(key), Date.now()]);
}

// ---- MCP: requests per user per minute (an agent in a loop, or a leaked token)
const MCP_PER_MINUTE = Number(process.env.MCP_RATE_LIMIT_PER_MINUTE ?? 120);
const calls = new Map<string, { start: number; n: number }>();

export function mcpRateLimited(key: string): boolean {
  const now = Date.now();
  const c = calls.get(key);
  if (!c || now - c.start >= 60_000) {
    calls.set(key, { start: now, n: 1 });
    return false;
  }
  c.n++;
  return c.n > MCP_PER_MINUTE;
}

// ---- MCP Origin check (DNS rebinding / browser pages calling the endpoint). MCP clients that run on a
// server send no Origin; a browser always does, and only our own origin or listed ones are accepted.
export function mcpOriginAllowed(origin: string | null, ownOrigin: string): boolean {
  if (!origin) return true;
  const allowed = [ownOrigin, ...(process.env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)];
  return allowed.includes(origin);
}
