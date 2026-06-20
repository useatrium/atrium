# Atrium — Daily Driver Wishlist

What Atrium should do well enough that it becomes the everyday home for working
with AI agents — replacing the ad-hoc terminal-and-tmux setup most of us use today.

The bar: spinning up an agent should feel **already there** — no setup, no
ceremony. Everything below is judged against that feeling. Atrium adds the things
a terminal can't: it works from your phone, it remembers everything, it's
shareable, and more than one person (or agent) can be in the room at once.

Two principles underneath all of it:

- **Files, not custom formats.** Notes, documents, and agent output are all just
  files you can preview, edit, and that agents can read directly. No proprietary
  doc format to learn or get locked into.
- **Warm, not cold.** Starting an agent should be instant, because the
  environment is kept ready in the background.

---

## The wishlist

### 1. Works everywhere — phone, desktop, web
One experience across web, an installable app, and mobile. Agents run in the
cloud, so your phone is a full remote control, not a stripped-down version.
Background mid-session, lose signal, come back — and you rejoin right where you
left off. The standout mobile moment: tap from your lockscreen, talk, and your
thought lands in your notes as text — capture an idea the second you have it.

### 2. A braindump notebook / "chief of staff"
A single place to think out loud — type it, say it, jot markdown. It's searchable,
it syncs across your devices, and agents can read it as context with no extra
setup. The notes you take simply *become* what your agents know.

### 3. Artifacts — anything an agent makes, kept and shown
When an agent produces something — a document, an image, a chart, a file — it's
automatically saved, versioned, and previewable. Edit a document in-app and it
keeps the history. Nothing an agent makes gets lost when the session ends.

### 4. Voice, video, and outside guests
Voice and calls already work. Add video, and the ability to pull in someone from
outside with a single link — scoped to just one conversation, no account needed.
Sharing a call, a document, or a read-only view of a channel should all work the
same simple way.

### 5. Instant agent spin-up
Starting an agent should feel like it was already running — sub-second, with your
repos and tools already in place. Speed is the whole point; if it's slow to start,
people fall back to the terminal.

### 6. Bring your own subscriptions
Use the AI subscriptions you already pay for (ChatGPT, Claude, Gemini) instead of
being billed per-use on top. Your credentials, your accounts.

### 7. Swap between AI tools freely
Not locked to one agent. Run Codex, Claude, Gemini, or newer tools as they appear.
Basic tools work immediately; the popular ones get richer, more integrated views
over time.

### 8. Remembers everything — and pulls in your other history
A complete, durable, searchable record of every session — yours forever, fully
exportable. Plus the ability to pull in agent history from your other machines so
everything lives in one searchable place. Sensitive content (pasted keys, tokens)
gets scrubbed before it's stored.

---

## Also worth having

- **Accounts & sharing** — sign in, pair devices, and one consistent way to share
  a session, a document, a guest invite, or a read-only view.
- **Secrets, handled well** — a real place to manage your provider logins, repo
  keys, and environment settings.
- **Don't lose context overnight** — agents can sleep and resume without forgetting
  where they were; idle agents shouldn't quietly cost money.
- **Cost visibility** — see what's being spent, per session, with simple budgets.
- **Notifications that matter** — especially "an agent needs your input," so you
  can walk away and get pulled back only when it counts.
- **Background & scheduled agents** — always-on helpers: repo watchers, recurring
  jobs, long-running tasks. The natural superpower of a cloud home over a terminal.
- **Safety rails** — sensible limits on what an agent's environment can touch
  (network, files, commands), so running real work stays safe.
- **Live collaboration** — more than one person or agent working the same material
  at once, with edits showing up for everyone within seconds.
- **Comms integration** — wire in email and calendar so "chief of staff" is
  literal, not a metaphor.

---

## Deliberately *not* doing

- A custom document / to-do / planning format. It's plain files + markdown, on
  purpose — nothing to learn, nothing to be locked into.
- Routing many people's Claude subscriptions through shared infrastructure
  (against the terms; individual use only).
- Rebuilding a history search tool that already exists — feed into it instead.
- Self-hosting heavy video infrastructure before there's scale to justify it.
