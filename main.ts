// The entry's lifecycle, which the harness (agent/v1) drives:
//
//   1. Bind an ephemeral port — server.listen(0), never 8080 (the env owns
//      that one, and on the one-pod layout it shares this loopback).
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register at once; the env records
//      the caller's address plus the port and dials it from then on. The
//      first register wins; a 409 means one already did, which is settled,
//      not an error.
//   3. Keep serving. The env probes GET /healthz twice inside its boot
//      budget, then runs its suite against the registered address.
//   4. Poll GET $MAKEFUN_ENV_URL/done — it answers at once, {"done": false}
//      while the suite runs — and exit 0 when it answers {"done": true}.
//
// The server itself lives in app.ts; this file is only the conversation
// with the env, plus the retries that conversation needs while the env is
// still starting.

import { createApp } from './app.ts';

/** How long one register or done request may take before it is retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Backoff between retries: 200 ms doubling to a 2 s cap. */
const RETRY_FIRST_MS = 200;
const RETRY_CAP_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The wait after `attempt` consecutive failures. */
function backoff(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 10));
}

/** POST the bound port until the env accepts it (200) or says one already won (409). */
async function register(envUrl: string, port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) {
        await response.arrayBuffer().catch(() => undefined);
        return;
      }
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register refused with HTTP ${response.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
      // A network error or a 5xx: the env may still be starting. Retry.
    }
    await sleep(backoff(attempt));
  }
}

/** Poll the env's /done until it answers {"done": true}; never return before. */
async function waitUntilDone(envUrl: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      } else {
        await response.arrayBuffer().catch(() => undefined);
      }
    } catch {
      // Not answering yet, or the poll timed out: not done either way.
    }
    await sleep(backoff(attempt));
  }
}

async function run(): Promise<void> {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') {
    process.stderr.write('[forge] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[forge] listening on port ${address.port}\n`);
  await register(envUrl, address.port);
  process.stdout.write('[forge] registered; serving until the env says done\n');
  await waitUntilDone(envUrl);
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
