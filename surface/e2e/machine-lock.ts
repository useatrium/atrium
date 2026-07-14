// Machine-wide mutex for the e2e suite.
//
// Ports and databases are isolated per checkout (see playwright.config.ts), so
// concurrent runs cannot corrupt each other. They can still STARVE each other.
// This box is 10 cores / 16GB and already runs an agent fleet in swap; each
// suite is ~6 load units (2 workers x Chromium's multi-process browser, plus
// Vite and a Fastify server), so two concurrent suites already oversubscribe it.
// The app server then misses the assertion budget wherever it happens to be,
// which looks exactly like flakiness and isn't — the failing test rotates.
// So: one suite at a time per machine, the rest queue.
//
// This lives in the Playwright *config* rather than an npm-script wrapper
// because a wrapper only guards `pnpm e2e`. Agents routinely run targeted specs
// with `pnpm exec playwright test <spec>`, which sailed straight past the
// wrapper and starved whoever held the machine. The config is evaluated by every
// entry point, and — verified — before `webServer` starts, so the lock also gates
// the Vite build and server boot rather than letting four runs idle with servers
// up.
//
// Not `flock`: util-linux, absent on macOS, which is where this matters.
import { linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_PATH = process.env.ATRIUM_E2E_LOCK ?? join(tmpdir(), 'atrium-e2e.lock');
const POLL_MS = 2_000;
// A full suite is ~2.5min idle. Waiting out a few beats failing, but never block
// a developer forever.
const MAX_WAIT_MS = Number(process.env.ATRIUM_E2E_LOCK_TIMEOUT_MS ?? 30 * 60_000);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function holderIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, does not touch the process
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'; // exists, owned by someone else
  }
}

// The lockfile must never be observable half-written. Creating it O_EXCL and
// *then* writing the pid is not enough: a racing process can read it in the gap,
// see "", parse NaN, decide the holder is dead, and delete a LIVE lock — which is
// exactly how the first version of this let two suites run at once. Write the pid
// to a private temp file and link() it into place instead: link fails EEXIST if
// held, and the file is complete the instant it is visible.
function tryAcquire(): boolean {
  const scratch = `${LOCK_PATH}.${process.pid}`;
  try {
    writeFileSync(scratch, `${process.pid}\n`);
    linkSync(scratch, LOCK_PATH);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
  } finally {
    try {
      unlinkSync(scratch);
    } catch {
      /* already gone */
    }
  }

  let holder: number;
  try {
    holder = Number.parseInt(readFileSync(LOCK_PATH, 'utf8').trim(), 10);
  } catch {
    return false; // vanished under us; re-contend next poll
  }
  // An unparseable lockfile is NOT proof of a dead holder. Never treat it as
  // stale, or we are back to deleting live locks.
  if (!Number.isInteger(holder) || holder <= 0) return false;
  if (holderIsAlive(holder)) return false;

  // A run killed with SIGKILL (how a wedged e2e run usually dies) leaves the file
  // behind. A stale lock that blocks the machine forever is worse than no lock.
  console.error(`[e2e-lock] clearing stale lock from dead pid ${holder}`);
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    /* another waiter cleared it first */
  }
  return false; // re-contend rather than assume we won
}

let held = false;

function release(): void {
  if (!held) return;
  held = false;
  try {
    // Only remove it if it is still OURS, or we would delete the lock of whoever
    // took over after a stale-clear.
    if (Number.parseInt(readFileSync(LOCK_PATH, 'utf8').trim(), 10) === process.pid) {
      unlinkSync(LOCK_PATH);
    }
  } catch {
    /* already gone */
  }
}

export async function acquireMachineLock(): Promise<void> {
  // Playwright evaluates the config in the main process AND in every worker. If a
  // worker also tried to acquire, it would block forever on the lock its own run
  // already holds — a deadlock far worse than the contention this prevents.
  // Workers carry TEST_WORKER_INDEX; the main process does not.
  if (process.env.TEST_WORKER_INDEX !== undefined) return;
  // CI already owns its container: a lock there adds a failure mode and buys
  // nothing.
  if (process.env.CI) return;
  if (process.env.ATRIUM_E2E_NO_LOCK === '1') return;

  const deadline = Date.now() + MAX_WAIT_MS;
  let announced = false;
  while (!tryAcquire()) {
    if (Date.now() > deadline) {
      console.error(`[e2e-lock] gave up after ${Math.round(MAX_WAIT_MS / 60_000)}m waiting for ${LOCK_PATH}`);
      process.exit(1);
    }
    let holder: string | null = null;
    try {
      holder = readFileSync(LOCK_PATH, 'utf8').trim();
    } catch {
      /* freed under us — just re-contend */
    }
    if (holder && !announced) {
      console.error(`[e2e-lock] another e2e run (pid ${holder}) is using this machine — waiting for it to finish…`);
      console.error('[e2e-lock] set ATRIUM_E2E_NO_LOCK=1 to run anyway (expect CPU starvation and false failures).');
      announced = true;
    }
    await sleep(POLL_MS);
  }
  held = true;

  // Release on every exit path. A lock that outlives its run is the one thing
  // worse than no lock; SIGKILL is covered by the stale-pid sweep above.
  process.on('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      release();
      process.exit(130);
    });
  }
}
