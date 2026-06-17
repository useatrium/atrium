# Slack → Atrium migration & bridge feasibility (2026-06-17)

Research note. Question: does Slack support exporting existing chat logs to
migrate *out* (Slack → Atrium), and how feasible is a mirror / two-way sync via
a bridge — specifically for teams that move to Atrium but still need to keep
shared Slack channels alive with external Slack users (vendors/clients)?

Nothing built. This scopes the options and recommends a direction.

## Bottom line

- **One-time export to migrate out: yes, but tiered by plan.** The clean path is
  the admin export tool / Discovery API, *not* API scraping — API scraping was
  crippled in 2025.
- **Two-way sync via a bridge: feasible, well-trodden pattern** (Matrix's
  `matrix-appservice-slack` / `mautrix-slack` are the references). The real
  choice is between a ToS-compliant **bot-relay** (slightly degraded identity
  UX) and a full-fidelity **puppeting** approach (ToS-gray, fragile). For a
  shipped product, bot-relay is the only sane option.
- **For the "keep talking to external Slack vendors/clients" scenario, a bridge
  is the right and permanent answer** — Slack Connect can't help once your team
  has left Slack.

## 1. Exporting existing logs (one-time migration)

Export is gated hard by plan. This is the #1 thing to internalize:

| Path | Plans | Scope | Notes |
|---|---|---|---|
| **Standard Export tool** | All (incl. Free/Pro) | **Public channels only** | Self-serve ZIP of JSON. No private channels, no DMs. |
| **Corporate / "all conversations" export** | Business+ | Public + private + DMs | Must **apply to Slack with legal justification** (litigation/compliance); Slack can deny. |
| **Discovery API** | Enterprise Grid only | Everything — public, private, DMs, files, **edit history + deleted messages** | Programmatic, full-fidelity. Org Owner enables approved third-party apps. |

**Export format** (consistent across tiers): a ZIP with `users.json`,
`channels.json`, and one folder per channel containing `YYYY-MM-DD.json` message
arrays. Messages carry `ts` (also the message ID), `user`, `text`, `blocks`
(rich text), `thread_ts` (threading), `reactions`, and file references. **Files
come as `url_private` URLs, not bytes** — need an auth token to download the
actual content (Discovery/corporate exports can include them).

### The 2025 gotcha that kills naive API scraping

"Skip the export tool, just pull `conversations.history` via the API" — that path
was deliberately gutted. **As of 2025-05-29, newly-created apps distributed
*outside* the Slack Marketplace are limited to 1 request/minute on
`conversations.history` and `conversations.replies`, max 15 messages/request.**
That's ~900 messages/hour per channel — backfilling a real workspace would take
months. Slack's stated goal was preventing bulk conversational-data exfiltration
(read: feeding LLMs).

**The exemptions are the workaround:**
- **Internal/custom apps the customer builds for their own workspace are NOT
  affected** — they keep Tier 3 (50+ req/min, 1,000 msgs/req).
- **Marketplace-approved apps** keep Tier 3.
- **Pre-existing installs** are grandfathered.

**Implication for Atrium:** don't ship a generic "connect your Slack" scraper —
it hits the 1/min wall. Instead either (a) ingest the **export ZIP** the
customer's admin generates (no rate limits at all, simplest), or (b) have the
customer install the importer as **their own internal app** to keep Tier 3.
Building an Atrium **import-from-Slack-export-ZIP** parser is the 80% solution
and sidesteps the rate-limit regime entirely.

## 2. Mirror / two-way bridge

Solved problem in pattern, but two fundamentally different fidelity tiers:

### Tier A — Bot-relay bridge (ToS-compliant, what you'd actually ship)

- **Inbound (Slack → Atrium):** subscribe to the **Events API**
  (`message.channels`, `message.groups`, reactions, edits, deletes) via webhook
  or **Socket Mode**. This is *push*, so it **dodges the `conversations.history`
  rate-limit clampdown** for ongoing mirroring — history calls only needed for
  the initial backfill.
- **Outbound (Atrium → Slack):** `chat.postMessage` with a bot token, using
  `username` + `icon_url` overrides to render each Atrium author's name/avatar.
  Threads via `thread_ts`, edits via `chat.update`, deletes via `chat.delete`,
  files via `files.upload`.
- **Catch:** every Atrium-originated message appears as **your bot app with an
  "APP" badge** (carrying the real author's name/avatar). Reactions can only be
  added *as the bot*. Presence/typing/DM fidelity limited. Good, not
  pixel-perfect.
- **Recommendation:** ship this **as a listed Marketplace app** — that also
  restores Tier 3 rate limits for backfill and keeps you ToS-clean.

### Tier B — Puppeting bridge (full fidelity, ToS-gray, don't ship)

- Uses **real user session tokens + cookies** (`xoxc`/`xoxd`, scraped from a
  logged-in Slack client) to post *as the actual user* through Slack's
  undocumented client API — this is `mautrix-slack`'s "double puppeting."
- Gives true bidirectional identity (no APP badge), but **violates ToS, breaks
  whenever Slack changes its internal API, risks account suspension, and
  requires every user to hand over session tokens.** Fine for a self-hosted
  personal bridge; not for a commercial product.

## 3. The specific scenario: shared channels with external Slack users

Strongest case for a bridge, worth reframing:

- **Slack Connect (native cross-org shared channels) doesn't apply** — it needs
  *both* sides on Slack. Once your team is on Atrium, vendors/clients who stayed
  on Slack can't Slack-Connect to you.
- So a bridge is **not throwaway migration scaffolding — it's a permanent
  interop surface.** Same niche Beeper/Texts.com and Mattermost's Slack bridge
  occupy: "we left, our partners didn't, keep the channel alive."
- Bot-relay tier is sufficient: external Slack users see a clearly-labeled
  bridge posting on behalf of Atrium users; Atrium users see Slack-side messages
  natively. The cosmetic APP badge is an acceptable cost for keeping external
  relationships without forcing vendors onto Atrium.

## Recommendation for Atrium

1. **Migration:** build a **Slack-export-ZIP importer** (Standard +
   Corporate/Discovery formats share the same JSON shape). Map users by Slack ID
   **and email** (identity reconciliation), preserve threads (`thread_ts`),
   reactions, pull files via `url_private`. For big workspaces or private/DM
   scope, guide the customer's admin to generate the export themselves
   (Business+/Enterprise) — compliant and unthrottled. Connects directly to the
   shared-workspace channels/threads model (see
   `notes/shared-workspace-sessions.md`) and the event-log import target (see
   `notes/data-lifecycle.md`).
2. **Interop bridge:** build the **bot-relay** version (Events API in,
   `chat.postMessage` with name/avatar override out), ship it **as a Marketplace
   app**, treat it as a durable product surface for external-partner channels.
   **Do not build puppeting** into the product.
3. **Set expectations** that bridged Slack messages carry an APP badge — the
   unavoidable cost of ToS-compliance.

## Sources

- [Rate limit changes for non-Marketplace apps (Slack changelog, 2025-05-29)](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)
- [Clarifying rate limit changes for non-Marketplace apps (Slack, 2025-06-03)](https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/)
- [Slack Web API rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)
- [Guide to Slack import and export tools (Slack Help)](https://slack.com/help/articles/204897248-Guide-to-Slack-import-and-export-tools)
- [Slack Discovery API / data export overview (Salesforce Trailhead)](https://trailhead.salesforce.com/content/learn/modules/data-protection-with-slack/natively-export-data)
- [mautrix-slack (puppeting bridge reference)](https://github.com/mautrix/slack) · [Double puppeting docs](https://docs.mau.fi/bridges/general/double-puppeting.html)
