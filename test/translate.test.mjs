import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.ANTIGRAVITY_CREDENTIALS_FILE = join(tmpdir(), 'dsh-antigravity-missing-credentials.json');

const { buildAntigravityPayload, parseAntigravityChunk, sanitizeSchema } = await import('../lib/translate.js');
const { resolveRuntimeModel, clampMaxTokens, catalogIds, buildEnvelope } = await import('../lib/models.js');
const { AntigravityAdapter } = await import('../lib/adapter.js');

test('routes public model ids onto quota runtime ids', () => {
  assert.equal(resolveRuntimeModel('gemini-3.8-flash', 'high'), 'gemini-3.8-flash-high');
  assert.equal(resolveRuntimeModel('gemini-3.8-flash', 'minimal'), 'gemini-3.8-flash-low');
  assert.equal(resolveRuntimeModel('antigravity/gemini-3.8-flash', 'medium'), 'gemini-3.8-flash-medium');
  assert.equal(resolveRuntimeModel('claude-sonnet-4-6', 'high'), 'claude-sonnet-4-6');
  assert.equal(resolveRuntimeModel('some-new-model', 'high'), 'some-new-model');
});

test('clamps output tokens per family', () => {
  assert.equal(clampMaxTokens('claude-sonnet-4-6', 100000), 64000);
  assert.equal(clampMaxTokens('gemini-3.8-flash', 100000), 65536);
  assert.equal(clampMaxTokens('gemini-3.8-flash', undefined), undefined);
});

test('builds a request envelope with system, tools and tool results', () => {
  const payload = buildAntigravityPayload({
    runtimeModel: 'gemini-3.8-flash-high',
    project: 'proj-1',
    sessionId: 'session-1',
    requestId: 'req-1',
    labels: { 'antigravity/cli-version': '1.3.3' },
    system: 'You are helpful.',
    tools: [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', anyOf: [{ type: 'string' }] } },
          additionalProperties: false,
        },
      },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Read a.txt' }] },
      {
        role: 'assistant',
        source: { kind: 'model', provider: 'antigravity', model: 'gemini-3.8-flash', replayState: { v: 1, toolSignatures: { call_1: 'sig-1' } } },
        content: [
          { type: 'text', text: 'Sure.' },
          { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'hello' }] },
    ],
  });

  assert.equal(payload.project, 'proj-1');
  assert.equal(payload.model, 'gemini-3.8-flash-high');
  assert.equal(payload.request.sessionId, 'session-1');
  assert.equal(payload.request.systemInstruction.parts[0].text, 'You are helpful.');
  assert.equal(payload.request.contents[0].role, 'user');
  const modelTurn = payload.request.contents[1];
  assert.equal(modelTurn.role, 'model');
  const callPart = modelTurn.parts.find(part => part.functionCall);
  assert.equal(callPart.functionCall.name, 'read_file');
  assert.equal(callPart.thoughtSignature, 'sig-1');
  const toolTurn = payload.request.contents[2];
  assert.equal(toolTurn.parts[0].functionResponse.name, 'read_file');
  assert.deepEqual(toolTurn.parts[0].functionResponse.response, { output: 'hello' });
  const parameters = payload.request.tools[0].functionDeclarations[0].parameters;
  assert.equal(parameters.properties.path.anyOf, undefined);
  assert.equal(parameters.additionalProperties, undefined);
});

test('merges consecutive same-role turns and starts with a user turn', () => {
  const payload = buildAntigravityPayload({
    runtimeModel: 'gemini-3.8-flash',
    project: 'p',
    sessionId: 's',
    requestId: 'r',
    labels: {},
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
    ],
  });
  assert.equal(payload.request.contents[0].role, 'user');
  assert.equal(payload.request.contents[0].parts[0].text, '[Conversation start]');
  assert.equal(payload.request.contents[2].parts.length, 2);
});

test('sanitizeSchema drops unsupported keywords recursively', () => {
  const schema = sanitizeSchema({
    type: 'object',
    anyOf: [{ type: 'string' }],
    properties: { list: { type: 'array', items: { oneOf: [{ type: 'string' }], type: 'string' } } },
  });
  assert.equal(schema.anyOf, undefined);
  assert.equal(schema.properties.list.items.oneOf, undefined);
});

test('parses text, reasoning, tool calls and usage from an SSE payload', () => {
  const text = parseAntigravityChunk(
    JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'hello' }] } }] } }),
  );
  assert.deepEqual(text.events, [{ type: 'text', text: 'hello' }]);

  const reasoning = parseAntigravityChunk(
    JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'think', thought: true }] } }] } }),
  );
  assert.deepEqual(reasoning.events, [{ type: 'reasoning', text: 'think' }]);

  const call = parseAntigravityChunk(
    JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'read_file', args: { path: 'a' }, id: 'c1' }, thoughtSignature: 'sig' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      },
    }),
  );
  const toolEvent = call.events.find(event => event.type === 'tool-call');
  assert.equal(toolEvent.signature, 'sig');
  assert.equal(call.finishReason, 'STOP');
  assert.deepEqual(call.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
});

test('envelope derives stable ids and labels', () => {
  const envelope = buildEnvelope({
    runtimeModel: 'gemini-3.8-flash-high',
    step: 3,
    requestIndex: 1,
    conversationId: 'conv',
    trajectoryId: 'traj',
    isClaude: false,
  });
  assert.equal(envelope.requestId, 'traj-1-3');
  assert.equal(envelope.sessionId, 'conv');
  assert.equal(envelope.labels['antigravity/model'], 'gemini_3.8_flash_high');
  assert.equal(envelope.labels['antigravity/step'], '3');
});

test('adapter advertises the catalog and exposes reasoning metadata', async () => {
  const adapter = new AntigravityAdapter();
  const models = await adapter.listModels('antigravity');
  assert.deepEqual(models.map(model => model.id), catalogIds());
  assert.equal(models[0].provider, 'antigravity');

  const resolved = await adapter.resolveModel('antigravity', 'gemini-3.8-flash');
  assert.equal(resolved.context.contextWindow, 1048576);
  assert.equal(resolved.systemPromptUpdate, 'in-history');
  assert.deepEqual(resolved.reasoning.efforts.map(effort => effort.id), ['off', 'low', 'medium', 'high']);

  const claude = await adapter.resolveModel('antigravity', 'claude-opus-4-6');
  assert.equal(claude.reasoning, undefined);
});

test('streaming without credentials ends with a MISSING_CREDENTIAL failure', async () => {
  const adapter = new AntigravityAdapter();
  const chunks = [];
  for await (const chunk of adapter.stream({
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    chunks.push(chunk);
  }
  const finish = chunks.at(-1);
  assert.equal(finish.type, 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, 'MISSING_CREDENTIAL');
});
