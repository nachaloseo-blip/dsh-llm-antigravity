/**
 * Host side of the Antigravity settings surface: OAuth attempt lifecycle,
 * account status, environment doctor and dependency checks.
 *
 * The Client half talks to this module through plain same-origin HTTP routes
 * registered on `ctx.webServer` (`/antigravity/*`). Routes are local-only and
 * reject cross-origin and header-less writes.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

import {
  CALLBACK_PORT,
  TOKEN_URL,
  ENDPOINT_FALLBACKS,
  userAgent,
} from './models.js';
import {
  buildAuthUrl,
  buildCredentialFromCode,
  clearCredentials,
  credentialsFile,
  exchangeCode,
  generatePkce,
  isExpiring,
  readCredentials,
  refreshTokens,
  startCallbackServer,
} from './auth.js';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ATTEMPT_TTL_MS = 180_000;
const DOC_TTL_MS = 30_000;

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers ?? {}),
    },
  });
}

export function codeFromPasted(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  if (text.includes('code=')) {
    try {
      return new URL(text).searchParams.get('code') ?? undefined;
    } catch {
      const match = /(?:^|[?&])code=([^&\s]+)/.exec(text);
      return match ? decodeURIComponent(match[1]) : undefined;
    }
  }
  return text;
}

async function portFree(port) {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

export class AntigravityBridge {
  #ctx;
  #attempt = null;
  #doctorCache = { at: 0, value: null };

  constructor(ctx) {
    this.#ctx = ctx;
  }

  // ── account ────────────────────────────────────────────────────────────

  async status() {
    const credentials = await readCredentials();
    if (!credentials) {
      return {
        signedIn: false,
        credentialsFile: credentialsFile(),
        attempt: this.#attemptView(),
      };
    }
    return {
      signedIn: true,
      email: credentials.email,
      projectId: credentials.project_id ?? 'antigravity-default',
      expiresAt: Number(credentials.expires_at ?? 0) || undefined,
      expiring: isExpiring(credentials),
      refreshable: Boolean(credentials.refresh_token),
      credentialsFile: credentialsFile(),
      attempt: this.#attemptView(),
    };
  }

  #attemptView() {
    const attempt = this.#attempt;
    if (!attempt) return null;
    return {
      id: attempt.id,
      state: attempt.state,
      url: attempt.url,
      portBusy: Boolean(attempt.portBusy),
      error: attempt.error,
    };
  }

  // ── sign-in ────────────────────────────────────────────────────────────

  async startLogin() {
    if (this.#attempt && this.#attempt.state === 'pending') {
      return { ...this.#attemptView(), reopened: true };
    }
    const { verifier, challenge } = generatePkce();
    const state = randomBytes(16).toString('hex');
    const attempt = {
      id: randomBytes(8).toString('hex'),
      verifier,
      state,
      url: buildAuthUrl({ challenge, state }),
      state: 'pending',
      createdAt: Date.now(),
      error: undefined,
      callback: null,
      timer: null,
      portBusy: false,
    };
    this.#attempt = attempt;

    try {
      attempt.callback = startCallbackServer({ state, timeoutMs: ATTEMPT_TTL_MS });
      await attempt.callback.ready;
      attempt.callback.result
        .then(({ code }) => this.#finish(attempt, code))
        .catch(error => {
          if (attempt.state === 'pending') {
            attempt.state = 'timeout';
            attempt.error = String(error?.message ?? error);
          }
        });
    } catch (error) {
      attempt.callback = null;
      attempt.portBusy = true;
      attempt.error = `Порт ${CALLBACK_PORT} занят. После входа скопируйте ссылку из адресной строки браузера и вставьте её сюда.`;
    }

    attempt.timer = setTimeout(() => {
      if (attempt.state === 'pending') {
        attempt.state = 'timeout';
        attempt.error = 'Время ожидания входа истекло.';
        attempt.callback?.close();
      }
    }, ATTEMPT_TTL_MS);
    attempt.timer.unref?.();

    // The browser is opened by the Settings page from the exact URL string, so
    // no shell-level command-line parsing can truncate the query string.
    return this.#attemptView();
  }

  async submitCode({ attemptId, value }) {
    const attempt = this.#attempt;
    if (!attempt || attempt.id !== attemptId) {
      return { state: 'failed', error: 'Попытка входа не найдена. Начните заново.' };
    }
    if (attempt.state === 'authorized') return this.#attemptView();
    const code = codeFromPasted(value);
    if (!code) {
      return { ...this.#attemptView(), error: 'Не найден код авторизации.' };
    }
    await this.#finish(attempt, code);
    return this.#attemptView();
  }

  async #finish(attempt, code) {
    if (attempt.state === 'authorized' || attempt.state === 'cancelled' || attempt.finishing) return;
    attempt.finishing = true;
    try {
      const tokenData = await exchangeCode(code, attempt.verifier);
      await buildCredentialFromCode({ tokenData });
      attempt.state = 'authorized';
      attempt.error = undefined;
      attempt.callback?.close();
      if (attempt.timer) clearTimeout(attempt.timer);
      this.#doctorCache = { at: 0, value: null };
    } catch (error) {
      attempt.state = 'failed';
      attempt.error = String(error?.message ?? error);
    }
  }

  async cancel() {
    if (this.#attempt?.state === 'pending') {
      this.#attempt.state = 'cancelled';
      this.#attempt.callback?.close();
      if (this.#attempt.timer) clearTimeout(this.#attempt.timer);
    }
    return this.#attemptView();
  }

  /** Close any live loopback listener when the plugin unloads. */
  dispose() {
    const attempt = this.#attempt;
    if (!attempt) return;
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.callback?.close();
    attempt.state = 'cancelled';
    this.#attempt = null;
  }

  async logout() {
    await this.cancel();
    await clearCredentials();
    this.#attempt = null;
    this.#doctorCache = { at: 0, value: null };
    return this.status();
  }

  async refresh() {
    const credentials = await readCredentials();
    if (!credentials?.refresh_token) {
      return { ok: false, error: 'Нет refresh-токена — нужен повторный вход.' };
    }
    try {
      await refreshTokens(credentials);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  // ── doctor ─────────────────────────────────────────────────────────────

  async doctor({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.#doctorCache.value && now - this.#doctorCache.at < DOC_TTL_MS) {
      return this.#doctorCache.value;
    }
    const items = [];
    for (const check of this.#checks()) {
      items.push(await check());
    }
    const value = { checkedAt: now, items };
    this.#doctorCache = { at: now, value };
    return value;
  }

  #checks() {
    return [
      () => {
        const major = Number(process.versions.node.split('.')[0] ?? 0);
        const ok = major >= 20 && typeof fetch === 'function';
        return {
          id: 'runtime',
          title: 'Среда выполнения',
          status: ok ? 'ok' : 'error',
          detail: ok
            ? `Node ${process.versions.node}, встроенный fetch`
            : 'Нужен Node 20+ со встроенным fetch',
        };
      },
      () => {
        const ok = Boolean(this.#ctx.get('llm'));
        return {
          id: 'llm-service',
          title: 'Сервис моделей Harness',
          status: ok ? 'ok' : 'error',
          detail: ok ? 'ctx.llm доступен' : 'Сервис llm не смонтирован',
        };
      },
      async () => {
        const file = credentialsFile();
        try {
          await mkdir(dirname(file), { recursive: true });
          const probe = join(dirname(file), `.probe-${process.pid}`);
          await writeFile(probe, 'ok');
          await rm(probe, { force: true });
          return {
            id: 'credentials-dir',
            title: 'Папка для токенов',
            status: 'ok',
            detail: dirname(file),
          };
        } catch (error) {
          return {
            id: 'credentials-dir',
            title: 'Папка для токенов',
            status: 'error',
            detail: String(error?.message ?? error),
            action: 'create-dir',
          };
        }
      },
      async () => {
        const free = await portFree(CALLBACK_PORT);
        return {
          id: 'oauth-port',
          title: `Локальный порт ${CALLBACK_PORT}`,
          status: free ? 'ok' : 'warn',
          detail: free
            ? 'Свободен: вход завершится автоматически'
            : 'Занят: вход придётся подтвердить вставкой ссылки',
          action: free ? undefined : 'recheck',
        };
      },
      async () => {
        try {
          await fetch(TOKEN_URL, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
          return {
            id: 'network',
            title: 'Доступ к Google',
            status: 'ok',
            detail: 'oauth2.googleapis.com отвечает',
          };
        } catch (error) {
          return {
            id: 'network',
            title: 'Доступ к Google',
            status: 'error',
            detail: String(error?.message ?? error),
            action: 'recheck',
          };
        }
      },
      async () => {
        const declared = await this.#declaredDependencies();
        if (declared.length === 0) {
          return {
            id: 'packages',
            title: 'Внешние пакеты',
            status: 'ok',
            detail: 'Не требуются: плагин работает на встроенном Node',
          };
        }
        const missing = [];
        for (const name of declared) {
          try {
            await import(name);
          } catch {
            missing.push(name);
          }
        }
        return {
          id: 'packages',
          title: 'Внешние пакеты',
          status: missing.length === 0 ? 'ok' : 'error',
          detail: missing.length === 0 ? `Установлены: ${declared.join(', ')}` : `Не найдены: ${missing.join(', ')}`,
          action: missing.length === 0 ? undefined : 'install',
        };
      },
      async () => {
        const credentials = await readCredentials();
        if (!credentials) {
          return {
            id: 'signin',
            title: 'Подписка Antigravity',
            status: 'warn',
            detail: 'Вход не выполнен — модели недоступны',
            action: 'signin',
          };
        }
        const info = await this.#probeAccount(credentials);
        return {
          id: 'signin',
          title: 'Подписка Antigravity',
          status: info.ok ? 'ok' : 'warn',
          detail: info.detail,
          action: info.ok ? undefined : 'signin',
        };
      },
    ];
  }

  async #declaredDependencies() {
    try {
      const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
      const deps = Object.keys(manifest.dependencies ?? {});
      return deps;
    } catch {
      return [];
    }
  }

  async #probeAccount(credentials) {
    let accessToken = credentials.access_token;
    if (isExpiring(credentials) && credentials.refresh_token) {
      try {
        accessToken = (await refreshTokens(credentials)).access_token;
      } catch (error) {
        return { ok: false, detail: `Не удалось обновить токен: ${error?.message ?? error}` };
      }
    }
    for (const endpoint of ENDPOINT_FALLBACKS) {
      try {
        const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': userAgent(),
          },
          body: JSON.stringify({ project: credentials.project_id ?? 'antigravity-default' }),
          signal: AbortSignal.timeout(6000),
        });
        if (!response.ok) continue;
        const data = await response.json();
        const count = data?.models && typeof data.models === 'object' ? Object.keys(data.models).length : 0;
        return {
          ok: true,
          detail: `${credentials.email ?? 'аккаунт'}: доступно моделей — ${count}`,
        };
      } catch {
        // Try the next candidate endpoint.
      }
    }
    return { ok: false, detail: 'Relay недоступен или подписка не активна' };
  }

  async fix(id) {
    if (id === 'credentials-dir') {
      await mkdir(dirname(credentialsFile()), { recursive: true }).catch(() => {});
    } else if (id === 'packages') {
      const installed = await this.#installDependencies();
      if (!installed.ok && installed.message) {
        return { doctor: await this.doctor({ force: true }), message: installed.message };
      }
    }
    return { doctor: await this.doctor({ force: true }) };
  }

  async #installDependencies() {
    const declared = await this.#declaredDependencies();
    if (declared.length === 0) return { ok: true };
    const subprocess = this.#ctx.get('subprocess');
    if (!subprocess) {
      return {
        ok: false,
        message: `Установите вручную: pnpm add ${declared.join(' ')}`,
      };
    }
    let executable;
    try {
      executable = await subprocess.resolveExecutable('pnpm');
    } catch {
      try {
        executable = await subprocess.resolveExecutable('npm');
      } catch {
        return { ok: false, message: `pnpm/npm не найден. Установите вручную: pnpm add ${declared.join(' ')}` };
      }
    }
    try {
      const handle = subprocess.spawn({
        argv: [executable, 'add', ...declared],
        cwd: PACKAGE_ROOT,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 65_536 },
          stderr: { maxBytes: 65_536 },
        },
        graceMs: 120_000,
      });
      const outcome = await handle.done;
      const stderr = handle.collected.stderr?.readFrom(0).text ?? '';
      if (outcome.exitCode !== 0) {
        return { ok: false, message: stderr.trim().slice(-500) || `Установка завершилась с кодом ${outcome.exitCode}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, message: String(error?.message ?? error) };
    }
  }

  // ── HTTP ───────────────────────────────────────────────────────────────

  /**
   * Node `http` handler for one exact webserver route: adapts the raw request
   * to the Fetch request `handle()` understands, then writes the response back.
   */
  async respond(req, res) {
    try {
      const method = String(req.method ?? 'GET').toUpperCase();
      const headers = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      let body;
      if (method !== 'GET' && method !== 'HEAD') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1_000_000) {
            res.statusCode = 413;
            res.end(JSON.stringify({ error: 'request body too large' }));
            return;
          }
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks).toString('utf8');
      }
      const origin = `http://${headers.host ?? '127.0.0.1'}`;
      const request = new Request(new URL(req.url ?? '/', origin), {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
      const response = await this.handle(request);
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.setHeader(name, value));
      if (method === 'HEAD') {
        res.end();
        return;
      }
      res.end(await response.text());
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
      }
      res.end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
  }

  async handle(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/antigravity\/?/, '');
    const method = request.method.toUpperCase();

    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) {
      return json({ error: 'cross-origin request refused' }, { status: 403 });
    }
    if (method === 'POST' && request.headers.get('x-antigravity-ui') !== '1') {
      return json({ error: 'missing client header' }, { status: 403 });
    }

    try {
      if (method === 'GET' && path === 'status') return json(await this.status());
      if (method === 'GET' && path === 'doctor') return json(await this.doctor());
      if (method === 'GET' && path === 'attempt') {
        const id = url.searchParams.get('id');
        const view = this.#attemptView();
        if (!view || view.id !== id) return json({ state: 'failed', error: 'Попытка входа не найдена' });
        return json(view);
      }
      if (method === 'POST' && path === 'doctor/fix') {
        const body = await request.json().catch(() => ({}));
        return json(await this.fix(String(body.id ?? '')));
      }
      if (method === 'POST' && path === 'login') return json(await this.startLogin());
      if (method === 'POST' && path === 'login/code') {
        const body = await request.json().catch(() => ({}));
        return json(await this.submitCode({ attemptId: String(body.attemptId ?? ''), value: body.value }));
      }
      if (method === 'POST' && path === 'cancel') return json(await this.cancel());
      if (method === 'POST' && path === 'logout') return json(await this.logout());
      if (method === 'POST' && path === 'refresh') return json(await this.refresh());
      return json({ error: 'not found' }, { status: 404 });
    } catch (error) {
      return json({ error: String(error?.message ?? error) }, { status: 500 });
    }
  }
}
