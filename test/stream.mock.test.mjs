import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { AntigravityAdapter } = await import('../lib/adapter.js');

async function withCredentials(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-antigravity-'));
  const file = join(dir, 'oauth.json');
  await writeFile(
    file,
    JSON.stringify({
      access_token: 'test-token',
      refresh_token: '',
      expires_at: Date.now() + 3_600_000,
      project_id: 'test-project',
      email: 'tester@example.com',
      ...overrides,
    }),
  );
  process.env.ANTIGRAVITY_CREDENTIALS_FILE = file;
  return file;
}

async function startMockRelay(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function sseBody(lines) {
  return lines.map(line => `data: ${JSON.stringify(line)}\n\n`).join('');
}

test('streams text, reasoning, tool calls, usage and replay state', async () => {
  await withCredentials();
  const relay = await startMockRelay((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      sseBody([
        { response: { candidates: [{ content: { parts: [{ text: 'Let me ' }] } }] } },
        { response: { candidates: [{ content: { parts: [{ text: 'think', thought: true }] } }] } },
        { response: { candidates: [{ content: { parts: [{ text: 'read it.' }] } }] } },
        {
          response: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: { name: 'read_file', args: { path: 'a.txt' }, id: 'c1' },
                      thoughtSignature: 'sig-1',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, totalTokenCount: 19 },
          },
        },
      ]),
    );
  });
  process.env.ANTIGRAVITY_BASE_URL = relay.url;

  try {
    const adapter = new AntigravityAdapter();
    const chunks = [];
    for await (const chunk of adapter.stream({
      model: 'gemini-3.8-flash',
      reasoningEffort: 'high',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read a.txt' }] }],
    })) {
      chunks.push(chunk);
    }

    const kinds = chunks.map(chunk => chunk.type);
    assert.ok(kinds.includes('block-start'));
    const text = chunks
      .filter(chunk => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('');
    assert.equal(text, 'Let me read it.');
    const reasoning = chunks
      .filter(chunk => chunk.type === 'reasoning-delta')
      .map(chunk => chunk.text)
      .join('');
    assert.equal(reasoning, 'think');

    const toolStart = chunks.find(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call');
    assert.ok(toolStart);
    const toolEnd = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
    assert.equal(toolEnd.block.name, 'read_file');
    assert.equal(toolEnd.block.arguments, '{"path":"a.txt"}');

    const usage = chunks.find(chunk => chunk.type === 'usage');
    assert.deepEqual(usage.usage, { inputTokens: 12, outputTokens: 7, totalTokens: 19 });

    const finish = chunks.at(-1);
    assert.equal(finish.reason.kind, 'tool-calls');
    assert.deepEqual(finish.replayState.toolSignatures, { c1: 'sig-1' });
    assert.ok(chunks.indexOf(usage) < chunks.indexOf(finish));
  } finally {
    delete process.env.ANTIGRAVITY_BASE_URL;
    await relay.close();
  }
});

test('maps HTTP 429 to a QUOTA failure chunk', async () => {
  await withCredentials();
  const relay = await startMockRelay((_request, response) => {
    response.writeHead(429, { 'Content-Type': 'application/json' });
    response.end('{"error":{"message":"quota"}}');
  });
  process.env.ANTIGRAVITY_BASE_URL = relay.url;

  try {
    const adapter = new AntigravityAdapter();
    const chunks = [];
    for await (const chunk of adapter.stream({
      model: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      chunks.push(chunk);
    }
    const finish = chunks.at(-1);
    assert.equal(finish.reason.kind, 'error');
    assert.equal(finish.reason.failure.code, 'QUOTA');
  } finally {
    delete process.env.ANTIGRAVITY_BASE_URL;
    await relay.close();
  }
});
