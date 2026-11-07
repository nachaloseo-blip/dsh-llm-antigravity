/**
 * Antigravity OAuth (PKCE) and credential storage.
 *
 * Credentials live in a JSON file outside the Harness configuration so that
 * access/refresh tokens never enter `cordis.patch.yml` or a settings document.
 * The plugin and the companion `login.mjs` both use this module.
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';

import {
  AUTH_URL,
  CALLBACK_HOST,
  CALLBACK_PORT,
  CLIENT_ID,
  CLIENT_SECRET,
  ENDPOINT_FALLBACKS,
  SCOPES,
  TOKEN_URL,
  USERINFO_URL,
  userAgent,
} from './models.js';

const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export function credentialsFile() {
  if (process.env.ANTIGRAVITY_CREDENTIALS_FILE) {
    return process.env.ANTIGRAVITY_CREDENTIALS_FILE;
  }
  return join(homedir(), '.dsh', 'antigravity', 'oauth.json');
}

export async function readCredentials() {
  try {
    const raw = await readFile(credentialsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.access_token !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeCredentials(credentials) {
  const file = credentialsFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(file, 0o600);
  } catch {
    // Windows has no POSIX mode; the profile directory ACL still applies.
  }
}

export async function clearCredentials() {
  await rm(credentialsFile(), { force: true });
}

export function isExpiring(credentials, skewMs = EXPIRY_SKEW_MS) {
  const expiresAt = Number(credentials?.expires_at ?? 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return true;
  return Date.now() >= expiresAt - skewMs;
}

function credentialError(message, code = 'AUTH') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function refreshTokens(credentials) {
  if (!credentials?.refresh_token) {
    throw credentialError('Antigravity credential has no refresh token. Run login.mjs again.');
  }
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: credentials.refresh_token,
    grant_type: 'refresh_token',
  });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw credentialError(
      `Antigravity token refresh failed (HTTP ${response.status}). Run login.mjs again.`,
      response.status === 400 || response.status === 401 ? 'INVALID_CREDENTIAL' : 'AUTH',
    );
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw credentialError('Antigravity token refresh returned malformed JSON.', 'AUTH');
  }
  const next = {
    ...credentials,
    access_token: String(data.access_token),
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000,
  };
  if (typeof data.refresh_token === 'string' && data.refresh_token) {
    next.refresh_token = data.refresh_token;
  }
  await writeCredentials(next);
  return next;
}

/**
 * Return a usable access token plus the project id, refreshing when needed.
 * @returns {Promise<{accessToken: string, projectId: string, credentials: object}>}
 */
export async function getAccessToken() {
  let credentials = await readCredentials();
  if (!credentials) {
    throw credentialError(
      `Not signed in to Google Antigravity. Run "node login.mjs" in the plugin directory (credentials file: ${credentialsFile()}).`,
      'MISSING_CREDENTIAL',
    );
  }
  if (isExpiring(credentials)) {
    if (!credentials.refresh_token) {
      throw credentialError(
        'Antigravity access token expired and no refresh token is stored. Run login.mjs again.',
        'AUTH',
      );
    }
    credentials = await refreshTokens(credentials);
  }
  return {
    accessToken: credentials.access_token,
    projectId: credentials.project_id || 'antigravity-default',
    credentials,
  };
}

export function generatePkce() {
  const verifier = randomBytes(48).toString('base64url').slice(0, 128);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthUrl({ challenge, state }) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: `http://localhost:${CALLBACK_PORT}/oauth-callback`,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'select_account',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Start the fixed-port loopback listener the registered redirect URI names. */
export function startCallbackServer({ state, timeoutMs = 120_000 }) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
    if (url.pathname !== '/oauth-callback') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><meta charset="utf-8"><title>Antigravity</title>' +
        '<h1>Antigravity authentication received</h1><p>You can close this tab and return to the harness.</p>',
    );
    if (!code) return;
    if (state && returnedState && returnedState !== state) return;
    settle({ code });
  });

  let settle;
  let timer;
  const result = new Promise((resolve, reject) => {
    settle = value => {
      clearTimeout(timer);
      server.close();
      resolve(value);
    };
    timer = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for the Google OAuth callback.'));
    }, timeoutMs);
  });
  // Keep the rejection handled even when the caller races another prompt.
  result.catch(() => {});

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => resolve());
  });

  return {
    ready,
    result,
    close() {
      clearTimeout(timer);
      server.close();
    },
  };
}

export async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: `http://localhost:${CALLBACK_PORT}/oauth-callback`,
  });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Antigravity code exchange failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text);
  if (typeof data.access_token !== 'string') {
    throw new Error('Antigravity code exchange returned no access token.');
  }
  return data;
}

export async function fetchUserEmail(accessToken) {
  try {
    const response = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return undefined;
    const data = await response.json();
    return typeof data.email === 'string' ? data.email : undefined;
  } catch {
    return undefined;
  }
}

function extractProjectId(data) {
  if (!data || typeof data !== 'object') return undefined;
  for (const key of [
    'projectId',
    'project_id',
    'antigravityProjectId',
    'antigravity_project_id',
    'cloudaicompanionProject',
    'userDefinedCloudaicompanionProject',
    'project',
  ]) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object' && typeof value.id === 'string') return value.id.trim();
  }
  return undefined;
}

/** Ask the relay which managed project this subscription bills against. */
export async function discoverProjectId(accessToken) {
  for (const endpoint of ENDPOINT_FALLBACKS) {
    try {
      const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': userAgent(),
        },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) continue;
      const data = await response.json();
      const project = extractProjectId(data);
      if (project) return project;
    } catch {
      // Try the next candidate endpoint.
    }
  }
  return undefined;
}

/** Exchange a fresh sign-in for the stored credential record. */
export async function buildCredentialFromCode({ tokenData, email }) {
  const accessToken = String(tokenData.access_token);
  const refreshToken =
    typeof tokenData.refresh_token === 'string' ? tokenData.refresh_token : '';
  const expiresIn = Number(tokenData.expires_in) || 3600;
  const projectId = (await discoverProjectId(accessToken)) || 'antigravity-default';
  const resolvedEmail = email || (await fetchUserEmail(accessToken)) || 'unknown';
  const credentials = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Date.now() + expiresIn * 1000 - 60_000,
    project_id: projectId,
    email: resolvedEmail,
    signed_in_at: new Date().toISOString(),
  };
  await writeCredentials(credentials);
  return credentials;
}
