#!/usr/bin/env node
/**
 * Sign in to Google Antigravity and store the OAuth credential the provider
 * plugin reads.
 *
 * Usage:
 *   node login.mjs                # interactive sign-in (browser + loopback callback)
 *   node login.mjs --accept-risk  # same, without the interactive consent prompt
 *   node login.mjs status         # show the stored account, project and expiry
 *   node login.mjs logout         # delete the stored credential
 *
 * WARNING: Google's Antigravity Additional Terms prohibit accessing the Service
 * with third-party software using Antigravity OAuth, and Google has disabled
 * accounts for it. This script is not affiliated with Google; use it at your own
 * risk. The ToS-compliant alternative is a metered Gemini API key.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { CALLBACK_PORT } from './lib/models.js';
import {
  buildAuthUrl,
  buildCredentialFromCode,
  clearCredentials,
  credentialsFile,
  exchangeCode,
  generatePkce,
  readCredentials,
  startCallbackServer,
} from './lib/auth.js';

const TOS_WARNING = `
WARNING: Google's Antigravity terms forbid accessing the service with third-party
software through Antigravity OAuth. Google has disabled accounts for this, and a
second violation can be permanent. Your Antigravity and Gemini CLI access may be
affected. For a ToS-compliant setup use a metered Gemini API key instead.
`;

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      // Never go through cmd.exe: it splits the URL at every '&', which drops
      // response_type and the other OAuth parameters.
      spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // The URL is printed either way.
  }
}

function parseCode(input) {
  const value = String(input).trim();
  if (!value) return undefined;
  if (value.includes('code=')) {
    try {
      const url = new URL(value);
      return url.searchParams.get('code') ?? undefined;
    } catch {
      const match = /(?:^|[?&])code=([^&\s]+)/.exec(value);
      return match ? decodeURIComponent(match[1]) : undefined;
    }
  }
  return value;
}

async function showStatus() {
  const credentials = await readCredentials();
  const file = credentialsFile();
  if (!credentials) {
    stdout.write(`Not signed in.\nCredential file: ${file}\n`);
    return 0;
  }
  const expiresAt = Number(credentials.expires_at ?? 0);
  const expired = !Number.isFinite(expiresAt) || expiresAt <= Date.now();
  stdout.write(`Signed in: ${credentials.email ?? 'unknown'}\n`);
  stdout.write(`Project:   ${credentials.project_id ?? 'antigravity-default'}\n`);
  stdout.write(
    `Expires:   ${Number.isFinite(expiresAt) && expiresAt > 0 ? new Date(expiresAt).toISOString() : 'unknown'}${expired ? ' (expired)' : ''}\n`,
  );
  stdout.write(`Refresh:   ${credentials.refresh_token ? 'stored' : 'missing'}\n`);
  stdout.write(`File:      ${file}\n`);
  return 0;
}

async function signIn({ acceptRisk }) {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    stdout.write(TOS_WARNING);
    if (!acceptRisk) {
      if (!stdin.isTTY) {
        stdout.write('Refusing to sign in without --accept-risk in a non-interactive shell.\n');
        return 1;
      }
      const answer = await rl.question('Type "yes" to continue at your own risk: ');
      if (answer.trim().toLowerCase() !== 'yes') {
        stdout.write('Cancelled.\n');
        return 1;
      }
    }

    const { verifier, challenge } = generatePkce();
    const state = randomBytes(16).toString('hex');
    const url = buildAuthUrl({ challenge, state });

    stdout.write('\nOpen this URL in your browser to sign in:\n\n');
    stdout.write(`  ${url}\n\n`);
    openBrowser(url);

    let callback = startCallbackServer({ state, timeoutMs: 180_000 });
    try {
      await callback.ready;
    } catch {
      callback = null;
      stdout.write(`\nPort ${CALLBACK_PORT} is busy, so the automatic callback could not start.\n`);
    }

    let code;
    if (callback) {
      stdout.write(`Waiting for the Google callback on http://localhost:${CALLBACK_PORT} ...\n`);
      try {
        ({ code } = await callback.result);
      } catch {
        stdout.write('\nThe automatic callback timed out.\n');
      }
    }

    if (!code) {
      stdout.write('Paste the full redirect URL (or just the authorization code) below.\n');
      const pasted = await rl.question('Code or URL: ');
      code = parseCode(pasted);
      callback?.close();
    }

    if (!code) {
      stdout.write('No authorization code received. Nothing was saved.\n');
      return 1;
    }

    stdout.write('Exchanging the authorization code...\n');
    const tokenData = await exchangeCode(code, verifier);
    const credentials = await buildCredentialFromCode({ tokenData });
    stdout.write(`\nSigned in as ${credentials.email ?? 'unknown'}.\n`);
    stdout.write(`Project:   ${credentials.project_id}\n`);
    stdout.write(`Saved to:  ${credentialsFile()}\n`);
    stdout.write('Antigravity models are now selectable in the harness model picker.\n');
    return 0;
  } finally {
    rl.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.find(arg => !arg.startsWith('-')) ?? 'login';
  const acceptRisk = args.includes('--accept-risk');

  if (command === 'status') return showStatus();
  if (command === 'logout') {
    await clearCredentials();
    stdout.write(`Removed ${credentialsFile()}\n`);
    return 0;
  }
  if (command === 'login') return signIn({ acceptRisk });

  stdout.write(`Unknown command "${command}". Use login, status or logout.\n`);
  return 1;
}

main().then(
  code => process.exit(code),
  error => {
    stdout.write(`\nFailed: ${error?.message ?? error}\n`);
    process.exit(1);
  },
);
