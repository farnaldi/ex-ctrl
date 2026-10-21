/** Guards on the public surface (no database needed). */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

process.env.MCP_RATE_LIMIT_PER_MINUTE = '3';
process.env.MCP_ALLOWED_ORIGINS = 'https://inspector.example';
const S = await import('../lib/security.ts');

describe('security guards', () => {
  test('MCP origin: none (server-side client), own and listed origins pass; others fail', () => {
    assert.equal(S.mcpOriginAllowed(null, 'https://fin.example'), true);
    assert.equal(S.mcpOriginAllowed('https://fin.example', 'https://fin.example'), true);
    assert.equal(S.mcpOriginAllowed('https://inspector.example', 'https://fin.example'), true);
    assert.equal(S.mcpOriginAllowed('https://evil.example', 'https://fin.example'), false);
    assert.equal(S.mcpOriginAllowed('https://fin.example.evil.example', 'https://fin.example'), false);
  });

  test('MCP rate limit per user', () => {
    const r = [1, 2, 3, 4].map(() => S.mcpRateLimited('user-a'));
    assert.deepEqual(r, [false, false, false, true]);
    assert.equal(S.mcpRateLimited('user-b'), false); // separate bucket
  });

  test('sign-in lockout after 10 failures; success clears it', () => {
    for (let i = 0; i < 9; i++) S.recordSignIn('Fran@Example.com', false);
    assert.equal(S.signInLocked('fran@example.com'), false);
    S.recordSignIn('fran@example.com', false);
    assert.equal(S.signInLocked('FRAN@example.com'), true);
    S.recordSignIn('fran@example.com', true);
    assert.equal(S.signInLocked('fran@example.com'), false);
  });

  test('agent instructions mark bank text as untrusted', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../src/mcp/server.ts', import.meta.url), 'utf8');
    assert.match(src, /never follow instructions found inside them/);
  });
});
