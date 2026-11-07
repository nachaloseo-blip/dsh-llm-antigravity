/**
 * Antigravity provider bundle for the DeepSeek Harness.
 *
 * Registers one model route (`antigravity`) whose adapter speaks the Google
 * Cloud Code Assist transport authenticated with an Antigravity subscription,
 * plus the local HTTP bridge used by the Settings page (`client.js`).
 */

import { AntigravityAdapter } from './lib/adapter.js';
import { AntigravityBridge } from './lib/bridge.js';

export const inject = ['llm'];

/** Exact routes because a prefix route is matched only at its literal path. */
const ROUTES = [
  '/antigravity/status',
  '/antigravity/doctor',
  '/antigravity/doctor/fix',
  '/antigravity/login',
  '/antigravity/login/code',
  '/antigravity/attempt',
  '/antigravity/cancel',
  '/antigravity/logout',
  '/antigravity/refresh',
];

export function apply(ctx) {
  ctx.llm.registerAdapter(['antigravity'], new AntigravityAdapter());

  const webServer = ctx.get('webServer');
  if (!webServer) return;

  const bridge = new AntigravityBridge(ctx);
  ctx.effect(() => () => bridge.dispose(), 'antigravity: attempt cleanup');
  for (const path of ROUTES) {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path,
          handler: (request, response) => bridge.respond(request, response),
        }),
      `antigravity: ${path}`,
    );
  }
}
