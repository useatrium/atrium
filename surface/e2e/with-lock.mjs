// Machine-wide mutex around the e2e suite.
//
// Ports and databases are isolated per checkout (see playwright.config.ts), so
// concurrent runs can no longer corrupt each other. They can still STARVE each
// other: every suite is 2 Playwright workers + Chromium + Vite + a Fastify
// server, and several of those on one dev box drive the load average past the
// core count until the app server stops answering inside the assertion budget.
// That looks exactly like flakiness and isn't. So only one suite runs at a time
// per machine; the rest queue.
//
// Not `flock` — that is util-linux and absent on macOS, where this actually
// matters. CI skips the lock entirely: each job already owns its container, so
// a lock there would add a failure mode and buy nothing.
//
// Usage: node e2e/with-lock.mjs <command> [args...]
import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_PATH = process.env.ATRIUM_E2E_LOCK ?? join(tmpdir(), 'atrium-e2e.lock');
const POLL_MS = 2_000;
// A full suite runs ~4 min on an idle box and ~11 min on a loaded one. Waiting
// out two of those beats failing, but we should never block a dev forever.
const MAX_WAIT_MS = Number(process.env.ATRIUM_E2E_LOCK_TIMEOUT_MS ?? 30 * 60_000);

const [, , command, ...args] = process.argv;
if (!command) {
  console.error('with-lock.mjs: no command given');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function holderIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 checks liveness without touching the process.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return err?.code === 'EPERM';
  }
}

function tryAcquire() {
  try {
    // 'wx' is O_CREAT|O_EXCL — atomic, so two racing runs cannot both win.
    const fd = openSync(LOCK_PATH, 'wx');
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return true;
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }

  // Someone holds it — or crashed while holding it. A run killed with SIGKILL
  // (which is how a wedged e2e run usually dies) leaves the file behind, and a
  // stale lockfile that blocks every future run would be worse than no lock.
  let holder;
  try {
    holder = Number.parseInt(readFileSync(LOCK_PATH, 'utf8').trim(), 10);
  } catch {
    return false; // vanished under us; next poll will retry cleanly
  }
  if (holderIsAlive(holder)) return false;

  console.error(`[e2e-lock] clearing stale lock from dead pid ${holder}`);
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    /* another waiter cleared it first */
  }
  return false; // re-contend on the next poll rather than assuming we won
}

let held = false;
function release() {
  if (!held) return;
  held = false;
  try {
    // Only remove it if it is still OURS — otherwise we would delete the lock
    // of whoever took over after a stale-clear.
    if (Number.parseInt(readFileSync(LOCK_PATH, 'utf8').trim(), 10) === process.pid) {
      unlinkSync(LOCK_PATH);
    }
  } catch {
    /* already gone */
  }
}

async function acquire() {
  const deadline = Date.now() + MAX_WAIT_MS;
  let announced = false;
  while (!tryAcquire()) {
    if (Date.now() > deadline) {
      console.error(`[e2e-lock] gave up after ${Math.round(MAX_WAIT_MS / 60_000)}m waiting for ${LOCK_PATH}`);
      process.exit(1);
    }
    // Only claim someone is holding the lock if someone actually is. A
    // stale-clear frees the file, and announcing "pid unknown is using this
    // machine" on the way through would be a lie.
    let holder = null;
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
}

const skip = process.env.CI || process.env.ATRIUM_E2E_NO_LOCK === '1';
if (!skip) await acquire();

const child = spawn(command, args, { stdio: 'inherit', shell: false });

// Release on every exit path, including Ctrl-C — a lock that outlives its run
// is the one thing worse than no lock.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
process.on('exit', release);

child.on('exit', (code, signal) => {
  release();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
