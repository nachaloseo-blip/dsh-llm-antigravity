/**
 * `LlmAdapter` implementation for the Antigravity provider route.
 *
 * The adapter speaks the Cloud Code Assist streaming API directly and adapts it
 * to the Harness `StreamChunk` vocabulary. It deliberately has no dependency on
 * `@deepseek-ai/dsh-llm`: the registry consumes the documented shape.
 */

import {
  catalogIds,
  catalogEntry,
  ENDPOINT_FALLBACKS,
  EFFORT_LABELS,
  buildEnvelope,
  resolveRuntimeModel,
  resolveTrajectory,
  userAgent,
} from './models.js';
import { buildAntigravityPayload, parseAntigravityChunk } from './translate.js';
import { getAccessToken, refreshTokens } from './auth.js';

const LIVE_MODEL_TTL_MS = 10 * 60 * 1000;

function httpError(message, { code, status } = {}) {
  const error = new Error(message);
  if (code) error.code = code;
  if (status) error.status = status;
  return error;
}

function isAbort(error, signal) {
  return Boolean(signal?.aborted) || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

/**
 * Map a relay runtime id back to the public id a model selection persists.
 * The relay advertises quota buckets such as `gemini-3.8-flash-high`; a
 * selection made from the static catalog uses `gemini-3.8-flash`, so both must
 * resolve to the same advertised entry or `session/model-unavailable` fires.
 */
function toPublicModelId(id) {
  if (catalogEntry(id)) return id;
  if (id === 'claude-opus-4-6-thinking') return 'claude-opus-4-6';
  if (id === 'claude-sonnet-4-6-thinking') return 'claude-sonnet-4-6';
  const stripped = id.replace(/-(low|medium|high|extra-low|tiered)$/, '');
  return stripped !== id && catalogEntry(stripped) ? stripped : id;
}

function failureOf(error) {
  return {
    message: String(error?.message ?? error ?? 'Antigravity request failed'),
    code: typeof error?.code === 'string' ? error.code : 'ADAPTER',
    ...(typeof error?.status === 'number' ? { status: error.status } : {}),
  };
}

function finishError(error) {
  return { type: 'finish', reason: { kind: 'error', failure: failureOf(error) } };
}

function finishAborted(error) {
  return {
    type: 'finish',
    reason: { kind: 'aborted', failure: { message: String(error?.message ?? 'aborted'), code: 'ABORTED' } },
  };
}

function validationMessage(bodyText) {
  try {
    const data = JSON.parse(bodyText);
    const payload = data?.error && typeof data.error === 'object' ? data.error : data;
    const details = Array.isArray(payload?.details) ? payload.details : [];
    for (const detail of details) {
      if (detail?.reason === 'VALIDATION_REQUIRED') {
        const url = detail?.metadata?.validation_url;
        const text = detail?.metadata?.validation_error_message;
        if (url) {
          return `Google account not verified. ${text ?? ''}\nOpen this link to verify: ${url}`;
        }
      }
    }
  } catch {
    // Fall through to the raw body.
  }
  return undefined;
}

async function postWithFailover(body, token, signal) {
  const endpoints = [
    process.env.ANTIGRAVITY_BASE_URL,
    ...ENDPOINT_FALLBACKS,
  ].filter(value => typeof value === 'string' && value.trim().length > 0);

  let lastError;
  let regionError;
  for (const endpoint of endpoints) {
    let response;
    try {
      response = await fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'User-Agent': userAgent(),
        },
        body,
        signal,
      });
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      lastError = httpError(`Antigravity endpoint ${endpoint} unreachable: ${error?.message ?? error}`, {
        code: 'TRANSPORT',
      });
      continue;
    }

    if (response.ok) return response;

    const text = await response.text().catch(() => '');
    if (response.status === 401) {
      throw httpError('Antigravity rejected the access token (HTTP 401).', {
        code: 'UNAUTHORIZED',
        status: 401,
      });
    }
    if (response.status === 403) {
      throw httpError(
        validationMessage(text) ?? `Antigravity refused the request (HTTP 403): ${text.slice(0, 300)}`,
        { code: 'AUTH', status: 403 },
      );
    }
    if (response.status === 429) {
      throw httpError(
        'Antigravity quota for this model is exhausted (HTTP 429). Another linked account or a quota reset is required.',
        { code: 'QUOTA', status: 429 },
      );
    }
    if (response.status === 400) {
      if (/location is not supported/i.test(text)) {
        // The relay's region gate depends on the edge that answers, so try the
        // next candidate endpoint and let the step-level retry policy re-run.
        regionError = httpError(
          'Antigravity cannot serve this Gemini model from your region (Google: "User location is not supported"). Use a VPN or proxy in a supported country, or pick a Claude model.',
          { code: 'REGION_BLOCKED', status: 400 },
        );
        continue;
      }
      throw httpError(`Antigravity rejected the request (HTTP 400): ${text.slice(0, 500)}`, {
        code: 'INVALID_REQUEST',
        status: 400,
      });
    }
    if ([404, 500, 502, 503, 504].includes(response.status)) {
      lastError = httpError(`Antigravity endpoint ${endpoint} answered HTTP ${response.status}.`, {
        code: 'SERVER',
        status: response.status,
      });
      continue;
    }
    throw httpError(`Antigravity request failed (HTTP ${response.status}): ${text.slice(0, 300)}`, {
      code: 'ADAPTER',
      status: response.status,
    });
  }
  // Prefer an actionable server answer over a bare transport failure, and the
  // region gate over "endpoint unreachable" when both were seen.
  if (lastError && lastError.code !== 'TRANSPORT') throw lastError;
  throw regionError ?? lastError ?? httpError('Antigravity request failed on every endpoint.', { code: 'TRANSPORT' });
}

export class AntigravityAdapter {
  #liveCache = { at: 0, ids: null };

  providerInfo(provider) {
    return { id: provider, name: 'Google Antigravity' };
  }

  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'REGION_BLOCKED'],
      backoff: { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 },
    };
  }

  imageRequestPricing() {
    return undefined;
  }

  imageRequestTarget() {
    return { width: 1024, height: 1024, maxBytes: 10 * 1024 * 1024 };
  }

  #modelInfo(provider, id) {
    const entry = catalogEntry(id);
    return {
      provider,
      id,
      name: entry?.name ?? id,
      ...(entry?.description ? { description: entry.description } : {}),
      inputModalities: ['text'],
    };
  }

  #resolved(provider, id) {
    const entry = catalogEntry(id);
    const info = {
      provider,
      id,
      name: entry?.name ?? id,
      ...(entry?.description ? { description: entry.description } : {}),
      inputModalities: ['text'],
      context: { contextWindow: entry?.contextWindow ?? 1_048_576 },
      defaultMaxTokens: entry?.maxTokens ?? 65_535,
      systemPromptUpdate: 'in-history',
    };
    if (Array.isArray(entry?.reasoning) && entry.reasoning.length > 0) {
      info.reasoning = {
        efforts: entry.reasoning.map(effort => ({
          id: effort,
          name: EFFORT_LABELS[effort] ?? effort,
        })),
        defaultEffort: 'low',
      };
    }
    return info;
  }

  async #liveModels() {
    const now = Date.now();
    if (this.#liveCache.ids && now - this.#liveCache.at < LIVE_MODEL_TTL_MS) {
      return this.#liveCache.ids;
    }
    let access;
    try {
      access = await getAccessToken();
    } catch {
      return null;
    }
    const ids = await this.#fetchAvailableModels(access.accessToken, access.projectId);
    if (Array.isArray(ids) && ids.length > 0) {
      this.#liveCache = { at: now, ids };
      return ids;
    }
    return null;
  }

  async #fetchAvailableModels(token, projectId) {
    for (const endpoint of ENDPOINT_FALLBACKS) {
      try {
        const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': userAgent(),
          },
          body: JSON.stringify({ project: projectId }),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) continue;
        const data = await response.json();
        const models = data?.models;
        if (!models || typeof models !== 'object') continue;
        const ids = [];
        for (const [id, info] of Object.entries(models)) {
          const tag = typeof info?.tagTitle === 'string' ? info.tagTitle.toLowerCase() : '';
          if (tag.includes('leaving') || tag.includes('unavailable')) continue;
          if (!/^(gemini-|claude-|gpt-oss-)/.test(id)) continue;
          ids.push(id);
        }
        if (ids.length > 0) return ids.sort();
      } catch {
        // Try the next candidate endpoint.
      }
    }
    return null;
  }

  async listModels(provider) {
    // Advertise the stable public catalog first, then any account-specific model
    // the relay reports. Runtime ids the relay scores quota on (`-low`, `-high`,
    // `-thinking`, ...) map back to their public id, because that is what a
    // selection persists and what `modelAvailable()` looks up at send time.
    const live = await this.#liveModels();
    const ids = new Set(catalogIds());
    for (const id of live ?? []) {
      if (/^(chat_|tab_)/.test(id) || /-disabled$/.test(id)) continue;
      ids.add(toPublicModelId(id));
    }
    return [...ids].map(id => this.#modelInfo(provider, id));
  }

  async resolveModel(provider, model) {
    return this.#resolved(provider, model);
  }

  async prepareCall(provider, model) {
    const resolved = this.#resolved(provider, model);
    return {
      model: resolved,
      stream: options => this.stream(options),
    };
  }

  async *stream(options) {
    const modelId = options?.model;
    const runtimeModel = resolveRuntimeModel(modelId, options?.reasoningEffort);
    const isClaude = runtimeModel.startsWith('claude-');
    const messages = Array.isArray(options?.messages) ? options.messages : [];

    let access;
    try {
      access = await getAccessToken();
    } catch (error) {
      yield finishError(error);
      return;
    }

    const trajectory = resolveTrajectory(options?.sessionId, messages);
    const envelope = buildEnvelope({
      runtimeModel,
      step: Math.max(1, messages.length),
      requestIndex: messages.filter(message => message?.role === 'assistant').length,
      conversationId: trajectory.conversationId,
      trajectoryId: trajectory.trajectoryId,
      isClaude,
    });

    const payload = buildAntigravityPayload({
      runtimeModel,
      messages,
      system: options?.system,
      tools: options?.tools,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      reasoningEffort: options?.reasoningEffort,
      project: access.projectId,
      sessionId: envelope.sessionId,
      requestId: envelope.requestId,
      labels: envelope.labels,
    });
    const body = JSON.stringify(payload);

    let response;
    try {
      response = await postWithFailover(body, access.accessToken, options?.signal);
    } catch (error) {
      if (isAbort(error, options?.signal)) {
        yield finishAborted(error);
        return;
      }
      if (error?.code === 'UNAUTHORIZED') {
        try {
          const refreshed = await refreshTokens(access.credentials);
          response = await postWithFailover(body, refreshed.access_token, options?.signal);
        } catch (retryError) {
          yield isAbort(retryError, options?.signal) ? finishAborted(retryError) : finishError(retryError);
          return;
        }
      } else {
        yield finishError(error);
        return;
      }
    }

    yield* this.#consume(response.body, runtimeModel, options?.signal);
  }

  async *#consume(body, runtimeModel, signal) {
    const state = {
      index: 0,
      current: null,
      usage: undefined,
      signatures: {},
      lastSignature: undefined,
      toolCalls: 0,
      finishReason: undefined,
    };
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for await (const chunk of body) {
        if (isAbort(null, signal)) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          yield* this.#handleLine(line, state);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        yield* this.#handleLine(buffer.trim(), state);
      }
    } catch (error) {
      yield* this.#closeCurrent(state);
      yield isAbort(error, signal) ? finishAborted(error) : finishError(error);
      return;
    }

    yield* this.#closeCurrent(state);

    if (state.usage) {
      yield { type: 'usage', usage: state.usage };
    }

    const hasToolCalls = state.toolCalls > 0;
    let kind = 'stop';
    if (state.finishReason === 'MAX_TOKENS' && !hasToolCalls) kind = 'max-tokens';
    else if (hasToolCalls) kind = 'tool-calls';

    const replayState =
      Object.keys(state.signatures).length > 0
        ? { v: 1, toolSignatures: state.signatures, ...(state.lastSignature ? { lastSignature: state.lastSignature } : {}) }
        : undefined;

    yield {
      type: 'finish',
      reason: { kind },
      ...(replayState ? { replayState } : {}),
    };
  }

  *#handleLine(line, state) {
    if (!line.startsWith('data:')) return;
    const payload = line.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') return;
    const parsed = parseAntigravityChunk(payload);
    if (!parsed) return;
    if (parsed.usage) state.usage = parsed.usage;
    if (parsed.finishReason) state.finishReason = parsed.finishReason;
    for (const event of parsed.events) {
      yield* this.#handleEvent(event, state);
    }
  }

  *#handleEvent(event, state) {
    if (event.type === 'signature') {
      state.lastSignature = event.signature;
      return;
    }
    if (event.type === 'text') {
      yield* this.#ensure(state, 'text');
      if (state.current) state.current.text += event.text;
      yield { type: 'text-delta', index: state.current.index, text: event.text };
      return;
    }
    if (event.type === 'reasoning') {
      yield* this.#ensure(state, 'reasoning');
      if (state.current) state.current.text += event.text;
      yield { type: 'reasoning-delta', index: state.current.index, text: event.text };
      return;
    }
    if (event.type === 'tool-call') {
      yield* this.#closeCurrent(state);
      const index = state.index++;
      const id = event.id || `call_${index}`;
      const name = event.name || 'tool';
      let argsText;
      try {
        argsText = JSON.stringify(event.args ?? {});
      } catch {
        argsText = '{}';
      }
      state.toolCalls += 1;
      if (event.signature) {
        state.signatures[id] = event.signature;
        state.lastSignature = event.signature;
      }
      yield { type: 'block-start', index, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index, id, name, argumentsDelta: argsText };
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id, name, arguments: argsText },
      };
    }
  }

  *#ensure(state, type) {
    if (state.current && state.current.type === type) return;
    yield* this.#closeCurrent(state);
    const index = state.index++;
    state.current = { index, type, text: '' };
    yield { type: 'block-start', index, blockType: type };
  }

  *#closeCurrent(state) {
    if (!state.current) return;
    const block =
      state.current.type === 'text'
        ? { type: 'text', text: state.current.text }
        : { type: 'reasoning', text: state.current.text };
    yield { type: 'block-end', index: state.current.index, block };
    state.current = null;
  }
}
