/**
 * Translation between the Harness LLM vocabulary and the Google Cloud Code
 * Assist wire format used by Antigravity.
 */

import { clampMaxTokens, thinkingConfig } from './models.js';

/** JSON Schema keywords the Antigravity relay rejects (notably for Claude). */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'unevaluatedProperties',
  'propertyNames',
  'patternProperties',
  'additionalProperties',
  '$schema',
  '$id',
  '$defs',
  'definitions',
  'const',
  'examples',
]);

export function sanitizeSchema(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, sanitizeSchema(child)]),
      );
    } else if (key === 'items') {
      out[key] = sanitizeSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function asBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function textOf(blocks) {
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image attachment omitted on a text-only route]');
    else if (block.type === 'file') parts.push(`[file attachment${block.attachment?.name ? `: ${block.attachment.name}` : ''} omitted]`);
  }
  return parts.join('\n');
}

function signaturesOf(message) {
  const replay = message?.source?.replayState;
  if (!replay || typeof replay !== 'object') return {};
  if (replay.toolSignatures && typeof replay.toolSignatures === 'object') {
    return replay.toolSignatures;
  }
  return {};
}

function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Build the full `v1internal:streamGenerateContent` body.
 *
 * @param {object} input
 * @param {string} input.runtimeModel wire model id (already routed)
 * @param {Array}  input.messages    Harness request messages
 * @param {string} [input.system]    one-shot system prompt
 * @param {Array}  [input.tools]     ToolSchema[]
 * @param {number} [input.temperature]
 * @param {number} [input.maxTokens]
 * @param {string} [input.reasoningEffort]
 * @param {string} input.project
 * @param {string} input.sessionId
 * @param {string} input.requestId
 * @param {object} input.labels
 */
export function buildAntigravityPayload(input) {
  const {
    runtimeModel,
    messages = [],
    system,
    tools = [],
    temperature,
    maxTokens,
    reasoningEffort,
    project,
    sessionId,
    requestId,
    labels,
  } = input;

  const contents = [];
  const systemParts = [];
  const seenSystemTexts = new Set();
  const toolNames = new Map();
  const unsignedToolIds = new Set();

  const addSystemText = text => {
    const value = typeof text === 'string' ? text : '';
    if (!value.trim() || seenSystemTexts.has(value)) return;
    seenSystemTexts.add(value);
    systemParts.push({ text: value });
  };

  if (typeof system === 'string' && system.trim()) {
    addSystemText(system);
  }

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role;
    const blocks = asBlocks(message.content);

    if (role === 'system' || role === 'developer') {
      addSystemText(textOf(blocks));
      continue;
    }

    if (role === 'user') {
      const parts = [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push({ text: block.text });
        } else if (block.type === 'image') {
          parts.push({ text: '[image attachment omitted on a text-only route]' });
        } else if (block.type === 'file') {
          const name = block.attachment?.name;
          parts.push({ text: `[file attachment${name ? `: ${name}` : ''} omitted]` });
        }
      }
      contents.push({ role: 'user', parts: parts.length > 0 ? parts : [{ text: '' }] });
      continue;
    }

    if (role === 'assistant') {
      const parts = [];
      const signatures = signaturesOf(message);
      const isGemini3 = /gemini-(2\.5|3)/.test(runtimeModel);
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          parts.push({ text: block.text });
        } else if (block.type === 'tool-call') {
          const id = String(block.id ?? `call_${parts.length}`);
          const name = String(block.name ?? 'tool');
          toolNames.set(id, name);
          const args = parseArguments(block.arguments);
          const signature = signatures[id];
          if (isGemini3 && !signature) {
            // Gemini 3 rejects an unsigned functionCall on the next step. Keep the
            // turn readable instead of fabricating a signature.
            unsignedToolIds.add(id);
            parts.push({ text: `[Action: invoked ${name} with ${JSON.stringify(args)}]` });
          } else {
            const part = {
              functionCall: { name, args: args ?? {}, id },
            };
            if (signature) part.thoughtSignature = signature;
            parts.push(part);
          }
        }
      }
      contents.push({ role: 'model', parts: parts.length > 0 ? parts : [{ text: '' }] });
      continue;
    }

    if (role === 'tool') {
      const callId = String(message.toolCallId ?? '');
      const name = toolNames.get(callId) ?? 'tool';
      let result = textOf(blocks);
      if (message.isError && result) result = `Error: ${result}`;
      if (unsignedToolIds.has(callId)) {
        contents.push({
          role: 'user',
          parts: [{ text: `[Observation from ${name}:\n${result}]` }],
        });
      } else {
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name,
                response: { output: result },
                id: callId,
              },
            },
          ],
        });
      }
    }
  }

  // Gemini requires strictly alternating user/model turns starting with user.
  const merged = [];
  for (const entry of contents) {
    if (!entry.parts || entry.parts.length === 0) continue;
    if (merged.length > 0 && merged[merged.length - 1].role === entry.role) {
      merged[merged.length - 1].parts.push(...entry.parts);
    } else {
      merged.push({ role: entry.role, parts: [...entry.parts] });
    }
  }
  if (merged.length > 0 && merged[0].role !== 'user') {
    merged.unshift({ role: 'user', parts: [{ text: '[Conversation start]' }] });
  }

  const request = { contents: merged };

  if (systemParts.length > 0) {
    request.systemInstruction = { role: 'user', parts: systemParts };
  }

  const generationConfig = {};
  if (typeof temperature === 'number' && Number.isFinite(temperature)) {
    generationConfig.temperature = temperature;
  }
  const outputLimit = clampMaxTokens(runtimeModel, maxTokens);
  if (outputLimit !== undefined) generationConfig.maxOutputTokens = outputLimit;
  const thinking = thinkingConfig(runtimeModel, reasoningEffort);
  if (thinking) generationConfig.thinkingConfig = thinking;
  if (Object.keys(generationConfig).length > 0) {
    request.generationConfig = generationConfig;
  }

  if (Array.isArray(tools) && tools.length > 0) {
    const functionDeclarations = [];
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object' || !tool.name) continue;
      functionDeclarations.push({
        name: tool.name,
        description: tool.description ?? '',
        parameters: sanitizeSchema(tool.parameters ?? { type: 'object', properties: {} }),
      });
    }
    if (functionDeclarations.length > 0) {
      request.tools = [{ functionDeclarations }];
    }
  }

  if (sessionId) request.sessionId = sessionId;
  if (labels) request.labels = labels;

  return {
    project,
    model: runtimeModel,
    request,
    requestType: 'agent',
    userAgent: 'antigravity',
    requestId,
  };
}

/**
 * Normalize one SSE `data:` payload into the pieces the stream assembler needs.
 */
export function parseAntigravityChunk(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;

  const response = data.response && typeof data.response === 'object' ? data.response : data;
  const events = [];

  const rawUsage = response.usageMetadata ?? data.usageMetadata;
  let usage;
  if (rawUsage && typeof rawUsage === 'object') {
    const input = Number(rawUsage.promptTokenCount ?? 0) || 0;
    const output = Number(rawUsage.candidatesTokenCount ?? 0) || 0;
    const total = Number(rawUsage.totalTokenCount ?? 0) || input + output;
    usage = { inputTokens: input, outputTokens: output, totalTokens: total };
    const thoughts = Number(rawUsage.thoughtsTokenCount ?? 0) || 0;
    if (thoughts > 0) usage.reasoningTokens = thoughts;
    const cacheRead = Number(rawUsage.cachedContentTokenCount ?? 0) || 0;
    if (cacheRead > 0) usage.cacheReadTokens = cacheRead;
  }

  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const candidate = candidates[0];
  let finishReason;
  if (candidate) {
    const raw = candidate.finishReason;
    if (raw === 'STOP') finishReason = 'STOP';
    else if (raw === 'MAX_TOKENS') finishReason = 'MAX_TOKENS';
    else if (raw) finishReason = String(raw);

    const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (part.thoughtSignature) events.push({ type: 'signature', signature: part.thoughtSignature });
      if (typeof part.text === 'string') {
        events.push({ type: part.thought === true ? 'reasoning' : 'text', text: part.text });
      }
      if (part.functionCall && typeof part.functionCall === 'object') {
        events.push({
          type: 'tool-call',
          id: part.functionCall.id ? String(part.functionCall.id) : undefined,
          name: part.functionCall.name ? String(part.functionCall.name) : 'tool',
          args: part.functionCall.args ?? {},
          signature: part.thoughtSignature,
        });
      }
    }
  }

  return { events, usage, finishReason };
}
