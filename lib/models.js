/**
 * Model catalog, wire model routing, request envelope and token limits for the
 * Google Antigravity (Cloud Code Assist) provider.
 *
 * The relay attributes quota per *runtime* model id (the `-low`/`-medium`/`-high`
 * suffixed ids), so a public id such as `gemini-3.8-flash` is never sent as-is.
 */

import { createHash } from 'node:crypto';

export const CLI_VERSION = '1.3.3';
export const CLI_BUILD = '996823801';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
export const CALLBACK_HOST = '127.0.0.1';
export const CALLBACK_PORT = 51121;

/** Google's public Antigravity desktop OAuth client (not a private secret). */
export const CLIENT_ID =
  process.env.ANTIGRAVITY_CLIENT_ID ||
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
export const CLIENT_SECRET =
  process.env.ANTIGRAVITY_CLIENT_SECRET || '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';

export const SCOPES = [
  'https://www.googleapis.com/auth/aicode',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

export const ENDPOINT_FALLBACKS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
];

export function userAgent() {
  const sys = process.platform;
  const osType = sys === 'win32' ? 'windows' : sys === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  return `antigravity/cli/${CLI_VERSION} (aidev_client; os_type=${osType}; arch=${arch}; cl=${CLI_BUILD}; auth_method=consumer)`;
}

/**
 * Public catalog used by the model picker and by metadata resolution. These are
 * advisory: the relay is authoritative about which ids an account may call.
 */
export const MODEL_CATALOG = [
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    description: 'Fast agentic coding model routed through Antigravity.',
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoning: ['off', 'low', 'medium', 'high'],
  },
  {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoning: ['off', 'low', 'medium', 'high'],
  },
  {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    contextWindow: 1048576,
    maxTokens: 65535,
    reasoning: ['off', 'low', 'medium', 'high'],
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    contextWindow: 1048576,
    maxTokens: 65535,
    reasoning: ['off', 'low', 'medium', 'high'],
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    contextWindow: 1048576,
    maxTokens: 65535,
    reasoning: ['off', 'low', 'medium', 'high'],
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    description: 'Anthropic model served through Antigravity (thinking always on).',
    contextWindow: 200000,
    maxTokens: 64000,
    reasoning: null,
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    description: 'Anthropic model served through Antigravity (thinking always on).',
    contextWindow: 200000,
    maxTokens: 64000,
    reasoning: null,
  },
];

const CATALOG_BY_ID = new Map(MODEL_CATALOG.map(model => [model.id, model]));

export function catalogEntry(modelId) {
  return CATALOG_BY_ID.get(modelId);
}

export function catalogIds() {
  return MODEL_CATALOG.map(model => model.id);
}

export const EFFORT_LABELS = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** Public id + reasoning effort -> runtime id the relay scores quota on. */
export const MODEL_ROUTING = {
  'gemini-3.8-flash': {
    off: 'gemini-3.8-flash-low',
    low: 'gemini-3.8-flash-low',
    medium: 'gemini-3.8-flash-medium',
    high: 'gemini-3.8-flash-high',
  },
  'gemini-3.7-flash': {
    off: 'gemini-3.7-flash-low',
    low: 'gemini-3.7-flash-low',
    medium: 'gemini-3.7-flash-medium',
    high: 'gemini-3.7-flash-high',
  },
  'gemini-3.6-flash': {
    off: 'gemini-3.6-flash-low',
    low: 'gemini-3.6-flash-low',
    medium: 'gemini-3.6-flash-medium',
    high: 'gemini-3.6-flash-high',
  },
  'gemini-3.5-flash': {
    off: 'gemini-3.5-flash-extra-low',
    low: 'gemini-3.5-flash-extra-low',
    medium: 'gemini-3.5-flash-low',
    high: 'gemini-3-flash-agent',
  },
  'gemini-3.1-pro': {
    off: 'gemini-3.1-pro-low',
    low: 'gemini-3.1-pro-low',
    medium: 'gemini-3.1-pro-low',
    high: 'gemini-pro-agent',
  },
  'claude-sonnet-4-6': {
    off: 'claude-sonnet-4-6',
    low: 'claude-sonnet-4-6',
    medium: 'claude-sonnet-4-6',
    high: 'claude-sonnet-4-6',
  },
  'claude-opus-4-6': {
    off: 'claude-opus-4-6-thinking',
    low: 'claude-opus-4-6-thinking',
    medium: 'claude-opus-4-6-thinking',
    high: 'claude-opus-4-6-thinking',
  },
};

export const MAX_OUTPUT_TOKENS = {
  claude: 64000,
  'gpt-oss': 32768,
  'gemini-3.8': 65536,
};
export const DEFAULT_MAX_OUTPUT_TOKENS = 65535;

export function normalizeEffort(effort) {
  if (!effort) return 'off';
  const value = String(effort).trim().toLowerCase();
  if (value === 'minimal' || value === 'low') return 'low';
  if (value === 'medium') return 'medium';
  if (value === 'high' || value === 'xhigh' || value === 'max') return 'high';
  return 'off';
}

export function resolveRuntimeModel(modelId, effort) {
  let clean = String(modelId || '').trim();
  if (clean.startsWith('antigravity/')) clean = clean.slice('antigravity/'.length);
  const routing = MODEL_ROUTING[clean];
  if (!routing) return clean;
  return routing[normalizeEffort(effort)] ?? routing.off;
}

export function clampMaxTokens(modelId, maxTokens) {
  if (maxTokens === undefined || maxTokens === null) return undefined;
  const name = String(modelId).toLowerCase();
  let cap = DEFAULT_MAX_OUTPUT_TOKENS;
  for (const [key, limit] of Object.entries(MAX_OUTPUT_TOKENS)) {
    if (name.includes(key)) {
      cap = limit;
      break;
    }
  }
  return Math.min(Math.max(1, Math.trunc(maxTokens)), cap);
}

/** Gemini thinking budget for a model that accepts `thinkingConfig`. */
export function thinkingConfig(modelId, effort) {
  const level = normalizeEffort(effort);
  if (level === 'off') return undefined;
  const name = String(modelId).toLowerCase();
  if (!(name.includes('gemini-2.5') || name.includes('gemini-3') || name.includes('claude-3-7'))) {
    return undefined;
  }
  const budgets = { low: 2048, medium: 8192, high: 16384 };
  return { thinkingBudget: budgets[level] ?? 8192 };
}

/** Deterministic RFC 4122 v5-shaped UUID from a seed (session affinity). */
export function stableUuid(seed) {
  const digest = createHash('sha1').update(String(seed)).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable conversation/trajectory ids so multi-turn usage stays one session. */
export function resolveTrajectory(sessionId, messages) {
  const explicit = String(sessionId || '').trim();
  let seed;
  if (explicit) {
    seed = `session:${explicit}`;
  } else {
    const first = Array.isArray(messages) && messages.length > 0 ? messages[0] : undefined;
    seed = JSON.stringify(first?.content ?? 'empty').slice(0, 96);
  }
  return {
    conversationId: stableUuid(`antigravity:conv:${seed}`),
    trajectoryId: stableUuid(`antigravity:traj:${seed}`),
  };
}

/** Request id, session id and labels for one Antigravity call. */
export function buildEnvelope({ runtimeModel, step, requestIndex, conversationId, trajectoryId, isClaude }) {
  const modelEnum = String(runtimeModel).replace(/-/g, '_');
  const stepValue = String(step);
  const labels = {
    'antigravity/cli-version': CLI_VERSION,
    'antigravity/model': modelEnum,
    'antigravity/step': stepValue,
    'antigravity/last-step-index': String(Math.max(0, step - 1)),
  };
  if (isClaude) labels['antigravity/provider'] = 'anthropic';
  return {
    requestId: `${trajectoryId}-${requestIndex}-${stepValue}`,
    sessionId: conversationId,
    labels,
  };
}
