// Phase-2 gate e2e: spawner + spectators see identical live state; reload
// recovers; permalink works for a late joiner; steer-after-completion works.
// Requires the full stack running (see JOURNAL): web :5173 -> server :3001 ->
// Centaur port-forward :18000 -> kind cluster with llm-mock.
// Run: node phase2/e2e/multispectator.mjs
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";

const require = createRequire("/opt/homebrew/lib/node_modules/dev-browser/");
const { chromium } = require("playwright");

const BASE = "http://127.0.0.1:5173";
const ART = new URL("./artifacts/", import.meta.url).pathname;
mkdirSync(ART, { recursive: true });

const results = [];
function record(check, ok, detail = "") {
  results.push({ check, ok, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${check} ${detail}`);
}

function maxSlowToken(text) {
  let max = -1;
  for (const m of text.matchAll(/slow-(\d{3})/g)) max = Math.max(max, Number(m[1]));
  return max;
}

async function login(ctx, handle, displayName) {
  const res = await ctx.request.post(`${BASE}/auth/login`, {
    data: { handle, displayName },
  });
  if (!res.ok()) throw new Error(`login ${handle}: ${res.status()}`);
}

async function snap(page, name) {
  try {
    await page.screenshot({ path: `${ART}${name}.png`, fullPage: false });
  } catch {}
}

const browser = await chromium.launch();
try {
  const ctxA = await browser.newContext({ baseURL: BASE });
  const ctxB = await browser.newContext({ baseURL: BASE });
  const ctxC = await browser.newContext({ baseURL: BASE });
  await login(ctxA, "alice-e2e", "Alice E2E");
  await login(ctxB, "bob-e2e", "Bob E2E");
  await login(ctxC, "carol-e2e", "Carol E2E");

  const a = await ctxA.newPage();
  await a.goto(BASE);
  const composer = a.locator("textarea").first();
  await composer.waitFor({ timeout: 15000 });
  await composer.fill("@agent SLOWSTREAM please");
  await composer.press("Enter");

  // The optimistic card appears; click it (or its open affordance) to open the pane.
  const card = a.locator("text=SLOWSTREAM").last();
  await card.waitFor({ timeout: 15000 });
  await card.click();
  await a.waitForURL(/\/s\//, { timeout: 15000 });
  const sessionUrl = new URL(a.url());
  const sessionPath = sessionUrl.pathname;
  record("spawn via @agent opens pane with /s/:id URL", true, sessionPath);

  const b = await ctxB.newPage();
  await b.goto(`${BASE}${sessionPath}`);
  await b.locator("text=SLOWSTREAM").first().waitFor({ timeout: 15000 });

  // Wait until streaming visibly started on both.
  await a.waitForFunction(
    () => /slow-\d{3}/.test(document.body.innerText),
    null,
    { timeout: 90000 },
  );
  await b.waitForFunction(
    () => /slow-\d{3}/.test(document.body.innerText),
    null,
    { timeout: 30000 },
  );

  // Sample both panes 3 times; positions should track closely.
  let worstGap = 0;
  for (let i = 0; i < 3; i++) {
    const [ta, tb] = await Promise.all([a.innerText("body"), b.innerText("body")]);
    const ga = maxSlowToken(ta);
    const gb = maxSlowToken(tb);
    worstGap = Math.max(worstGap, Math.abs(ga - gb));
    await new Promise((r) => setTimeout(r, 3000));
  }
  record("spawner + spectator track identical live state", worstGap <= 4, `worst token gap=${worstGap}`);
  await snap(a, "mid-run-spawner");
  await snap(b, "mid-run-spectator");

  const watching = (await a.innerText("body")).match(/(\d+)\s*watching/i);
  record("spectator presence visible", !!watching && Number(watching[1]) >= 2,
    watching ? `${watching[1]} watching` : "no watcher count found");

  // Reload recovery mid-run: after reload, the from-zero refold must catch up
  // to (and pass) the pre-reload live position. Poll — the refold is rAF-batched.
  const preReload = maxSlowToken(await a.innerText("body"));
  await a.reload();
  let afterReload = -1;
  const reloadDeadline = Date.now() + 45000;
  while (Date.now() < reloadDeadline) {
    afterReload = maxSlowToken(await a.innerText("body"));
    if (afterReload > preReload) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  record(
    "reload mid-run recovers transcript and catches up past pre-reload position",
    afterReload > preReload,
    `pre=${preReload} post=${afterReload}`,
  );

  // Completion on both.
  for (const [page, who] of [[a, "spawner"], [b, "spectator"]]) {
    await page.waitForFunction(
      () => /completed/i.test(document.body.innerText),
      null,
      { timeout: 150000 },
    );
    record(`${who} sees COMPLETED`, true);
  }
  await snap(b, "completed-spectator");

  // Late joiner via permalink.
  const c = await ctxC.newPage();
  await c.goto(`${BASE}${sessionPath}`);
  await c.waitForFunction(
    () => /slow-000/.test(document.body.innerText) && /completed/i.test(document.body.innerText),
    null,
    { timeout: 30000 },
  );
  record("late joiner permalink renders full transcript + terminal chip", true);
  await snap(c, "late-joiner");

  // Steer after completion (multi-turn edge): spawner sends a follow-up.
  const paneComposer = a.locator("textarea").last();
  const enabled = await paneComposer.isEnabled().catch(() => false);
  if (enabled) {
    await paneComposer.fill("Reply with exactly PONG and nothing else.");
    await paneComposer.press("Enter");
    const gotPong = await a
      .waitForFunction(
        () => document.body.innerText.includes("PONG"),
        null,
        { timeout: 90000 },
      )
      .then(() => true)
      .catch(() => false);
    record("steer after completion streams new turn into open pane", gotPong);
    await snap(a, "after-steer");
  } else {
    record("steer after completion streams new turn into open pane", false, "pane composer not enabled for spawner");
  }

  // Live tool-card check: spawn a TOOLTEST session and assert a Bash tool card
  // renders with the roundtripped output.
  await a.goto(BASE);
  const composer2 = a.locator("textarea").first();
  await composer2.waitFor({ timeout: 15000 });
  await composer2.fill("@agent TOOLTEST - run the Bash command the model requests, then report its output.");
  await composer2.press("Enter");
  const card2 = a.locator("text=TOOLTEST").last();
  await card2.waitFor({ timeout: 15000 });
  await card2.click();
  await a.waitForURL(/\/s\//, { timeout: 15000 });
  const gotTool = await a
    .waitForFunction(
      () => /Bash/.test(document.body.innerText) && /TOOLCHAIN_OK/.test(document.body.innerText),
      null,
      { timeout: 60000 },
    )
    .then(() => true)
    .catch(() => false);
  record("live TOOLTEST renders Bash tool card + TOOLCHAIN_OK result", gotTool);
  await snap(a, "tooltest-pane");
} finally {
  await browser.close();
}

const fails = results.filter((r) => !r.ok);
writeFileSync(`${ART}report.json`, JSON.stringify(results, null, 2));
console.log(`\n${results.length - fails.length}/${results.length} e2e checks passed`);
process.exit(fails.length ? 1 : 0);
