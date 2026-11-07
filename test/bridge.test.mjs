import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.ANTIGRAVITY_CREDENTIALS_FILE = join(tmpdir(), 'dsh-antigravity-bridge-missing.json');

const { AntigravityBridge, codeFromPasted } = await import('../lib/bridge.js');

const fakeContext = { get: () => undefined };

function request(path, init) {
  return new Request(`http://127.0.0.1:3080/antigravity/${path}`, init);
}

test('status reports signed out without credentials', async () => {
  const bridge = new AntigravityBridge(fakeContext);
  const response = await bridge.handle(request('status'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const data = await response.json();
  assert.equal(data.signedIn, false);
  assert.equal(data.attempt, null);
});

test('writes require the client header, cross-origin is refused', async () => {
  const bridge = new AntigravityBridge(fakeContext);
  const noHeader = await bridge.handle(request('logout', { method: 'POST' }));
  assert.equal(noHeader.status, 403);

  const crossOrigin = await bridge.handle(
    request('logout', {
      method: 'POST',
      headers: { 'x-antigravity-ui': '1', origin: 'https://evil.example' },
    }),
  );
  assert.equal(crossOrigin.status, 403);

  const unknown = await bridge.handle(request('nope'));
  assert.equal(unknown.status, 404);
});

test('doctor reports runtime, packages and sign-in prerequisites', async () => {
  const bridge = new AntigravityBridge(fakeContext);
  const doctor = await bridge.doctor({ force: true });
  const byId = new Map(doctor.items.map(item => [item.id, item]));

  assert.equal(byId.get('runtime').status, 'ok');
  assert.equal(byId.get('packages').status, 'ok');
  assert.equal(byId.get('signin').status, 'warn');
  assert.equal(byId.get('signin').action, 'signin');
  assert.equal(byId.get('credentials-dir').status, 'ok');
  assert.ok(byId.has('network'));
  assert.ok(byId.has('oauth-port'));
});

test('submitting a code for an unknown attempt fails cleanly', async () => {
  const bridge = new AntigravityBridge(fakeContext);
  const response = await bridge.handle(
    request('login/code', {
      method: 'POST',
      headers: { 'x-antigravity-ui': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'missing', value: 'http://localhost:51121/oauth-callback?code=abc' }),
    }),
  );
  const data = await response.json();
  assert.equal(data.state, 'failed');
  assert.match(data.error, /не найдена/i);
});

test('pasted redirect URLs and raw codes are understood', () => {
  assert.equal(codeFromPasted('http://localhost:51121/oauth-callback?code=abc123&state=x'), 'abc123');
  assert.equal(codeFromPasted('code=abc123'), 'abc123');
  assert.equal(codeFromPasted('  raw-code  '), 'raw-code');
  assert.equal(codeFromPasted(''), undefined);
});
