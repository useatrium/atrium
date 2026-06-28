# Atrium

**A shared workspace where people and AI agents work side by side.**

Atrium is an open-source, self-hostable place to run, watch, and work alongside
coding agents, as easily as a team chats in Slack. You talk in channels and
threads, you put agents on tasks with `@agent`, and everything an agent does (its
live transcript, the files it changes, the results it produces) shows up in one
shared place the whole team can see.

It has two halves:

- **A place to collaborate.** Chat, presence, and agent **sessions** you can watch
  live, take over, and link to, just like any other message.
- **A shared file store.** One place where many agents and people can edit the same
  files at once without overwriting each other's work.

> Full architecture walkthrough: **https://gbasin.github.io/atrium-architecture/**

## Why

Running one agent in your terminal is easy. Running lots of them, across a team and
over shared files, is where it falls apart:

- **You can't see the work.** An agent's output sits in one person's terminal.
  Everyone else finds out when it gets pasted into chat.
- **Safe agents are sealed off.** A safe agent runs locked in a sandbox that nothing
  can connect into, which is exactly what makes sharing its files and giving it team
  context hard.
- **Edits collide.** When several agents and people touch the same files, the naive
  approach quietly loses changes.

Atrium's bet: give each agent an ordinary folder to work in and a shared thread to
talk in, then do all the copying and merging from outside the sandbox. Nothing
needs to connect into the agent, and no work gets silently dropped.

The idea being tested: people will actually watch and join each other's agent
sessions, and sharing a session replaces pasting the output.

## Who it's for

Teams (and solo developers) who lean on AI coding agents and want that work to be
visible and shared, instead of a private tool whose results get copied around by
hand. It's self-hostable, so your code, your context, and your credentials stay
with you.

## Quickstart

This runs the chat side of Atrium on your machine. (Live agent sessions also need a
Centaur runtime, explained below.)

Prereqs: Node 24+, pnpm 10+, Docker.

```bash
cd surface
docker compose up -d --wait   # Postgres + file storage
pnpm install
pnpm migrate                  # also runs automatically on boot
pnpm dev                      # server on :3001, web on :5173
```

Open http://localhost:5173. The first run creates a workspace called **atrium** with
a **#general** channel.

## Core ideas

- **Places** are channels and threads: the durable, named, human side of the app.
- **Sessions** are units of agent work. A session is more like a pull request than a
  chat room: you start one from a thread, watch it run, steer it across as many turns
  as it takes, hand off control, link to it from anywhere, and it posts its result and
  a summary back when it's done. (It even reopens for another turn when someone replies.)
- **Artifacts** are the files agents produce (docs, datasets, notebooks, images).
  Every version is kept, and when two edits collide both are saved rather than one
  being lost.
- **Everything is on the record.** Every message, tool call, edit, and approval is
  saved with who did it and when, so any result can be traced back.

The core move: type `@agent <task>` in a thread, a session starts, a live card
appears, you can pop it into a side-by-side pane (several people can watch at once),
hand someone the controls, and a final card lands with a permanent link to the full
transcript.

## Architecture

Four layers do four different jobs. They're easy to mix up, so here's each one:

| Layer | What it is | What it does |
|---|---|---|
| **Atrium** | the product in this repo: the web, desktop, and mobile apps plus the server | Keeps **all the data that lasts**: the message log, every file version, the database, and file storage. This is what the team uses. |
| **Centaur** | the engine that runs the agents (our fork of [paradigmxyz/centaur](https://github.com/paradigmxyz/centaur), Apache-2.0 OR MIT — vendored in [`centaur/`](centaur/)) | Starts a locked-down, throwaway sandbox and runs the agent a turn at a time, streaming results back. Each turn is a clean sandbox; the conversation persists in Atrium, so a session keeps going across turns. Keeps **nothing** permanently. |
| **Harness** | the agent program inside the sandbox | The "hands": it reads the task, runs tools, and edits files. Atrium doesn't care which one you use (**Claude Code**, **Codex**, **amp**, and so on). |
| **Model** | the AI model the harness talks to | The "brain" (Claude, GPT, and so on). You can swap it per session. Billing and login follow the credentials the harness actually uses. |

In short: Atrium keeps the data and runs the experience, Centaur runs the agents
safely, and the harness and model plug into Centaur. Each turn goes:

> **Atrium** starts a **session** → **Centaur** runs a **harness** in a sandbox →
> the harness asks a **model** → results stream back and any new files are copied
> out → **Atrium** saves them and shows the team.

A session is a sequence of these turns: you can steer a running agent, answer its
questions, and send follow-ups — and a finished session reopens when someone replies.

### Models, login, and billing

Atrium does not bill for model usage itself. The harness and Centaur deployment
choose the model and credentials for each run. When a user has connected a
supported subscription login, Atrium sends that credential with the session and
the harness uses subscription auth. If no subscription login is connected, Atrium
still starts the session and lets the harness fall back to the deployment's
default auth, which is often an API key.

That means billing follows the active login path: connected subscription logins
use the user's provider subscription or workspace entitlement; API-key fallback
uses the configured API account and normal usage billing. The web app currently
has subscription-login connectors for **Codex** and **Claude Code**; other
harnesses use their Centaur/default configuration until a connector is added.
Treat connected provider credentials like passwords: Atrium stores them encrypted
and only injects them into the sandbox for the session that needs them.

Because the sandbox lets nothing connect into it, a small program on the host
machine (the **node daemon**) does the copying in both directions:

```
                 Humans  (web · desktop · mobile)
                         │  REST + live updates
       ┌─────────────────▼───────────────────────────┐
       │                Atrium Server                   │
       │  keeps all the data that lasts:                │
       │   · the message log (every message and         │
       │     session, in order)                         │
       │   · the file store (every version, in S3)      │
       └───────▲────────────────────────┬──────────────┘
               │ results + files         │ start a session
       ┌───────┴────────────────────────▼──────────────┐
       │     node daemon  (runs on the host machine)     │
       │     copies files out   ·   syncs updates in     │
       └───────▲────────────────────────┬──────────────┘
               │ read the changes        │ write into /workspace
       ┌───────┴────────────────────────▼──────────────┐
       │   Centaur sandbox   (nothing can connect in)    │
       │   ┌─────────────────────────────────────────┐  │
       │   │ harness  (Claude Code · Codex · amp · …) │  │
       │   │ /workspace = the agent's files            │  │
       │   │ /atrium    = read-only team context       │  │
       │   └───────────────────┬─────────────────────┘  │
       └───────────────────────┼────────────────────────┘
                               │ proxy adds the credentials
                               ▼
                  Model (AI)   (keys never enter the sandbox)
```

### What Atrium keeps

Two things:

- **A message log.** One running list of everything that happened (messages, edits,
  reactions, threads, sessions, course-corrections to a running agent, answered
  questions), in order. The channel list, unread counts, and presence are all worked
  out from it.
- **A file store.** Every version of every file, with the bytes in S3 and a small
  index in the database. It keeps version history and, when edits collide, both
  sides.

### Three kinds of data

Atrium stores each kind of thing the way that suits it:

| Kind | Examples | Where it lives | How it behaves |
|---|---|---|---|
| **Messages** | chat, transcripts | the message log (Postgres), batched into S3 | only ever added to |
| **Files** | docs, datasets, notebooks, images | S3 plus an index in Postgres | versioned; colliding edits are both kept |
| **Code** | source repositories | ordinary Git, on GitHub or similar | Git's branches |

### The agent's workspace

Inside the sandbox the agent works in an ordinary folder, `/workspace`. It sees the
shared files as a read-only base with its own changes layered on top, so its edits
never touch anyone else's copy. Noisy folders (`node_modules`, `.venv`, caches,
checked-out Git repos) are kept out of the shared pool so they don't get copied
around by accident.

The agent also gets `/atrium`, a read-only view of team context: chat history, other
agents' transcripts, a list of available files, and a search tool. It's prepared
once per machine and shared by every sandbox on it.

### Copying and merging, from outside the sandbox

Since nothing can connect into a sandbox, the host-side node daemon moves the data:

- **Out:** it reads what the agent changed from the host side, so the locked-down
  agent never has to expose anything. This grows with the number of machines, not
  the number of agents.
- **In:** it writes fresh versions into the agent's workspace. If the agent also
  changed that file, the two versions are merged; otherwise the update just lands.
  Team context stays current by simply being added to, usually within seconds.

### Conflicts don't block

When two edits collide, nothing stops or fails. The file's newest version still
moves forward; it's just flagged as conflicting and keeps both edits, so a person or
agent can sort it out later like any other change. (This follows how the Jujutsu
version-control system handles conflicts.)

### Starting fast

Spinning up an agent is warmed in layers, so it's productive in seconds rather than
minutes: a pool of pre-booted sandboxes (no wait for a machine), a pre-baked toolchain
image, a per-machine mirror of Git repos, and — unique to Atrium — a shared cache of
installed dependencies and compiled output, content-addressed so any machine can reuse
it. The runtime (Centaur, upstream) provides the pool, image, and repo mirror; Atrium
adds the dependency/build cache on top. The full breakdown of what's upstream vs. what
Atrium adds is in
[`centaur/ATRIUM_FORK.md`](centaur/ATRIUM_FORK.md#sandbox-warming--cold-start-lifecycle).

## Repo layout

| Path | What's there |
|---|---|
| `surface/` | the product: `server/` (Node + TypeScript, Fastify, Postgres), `web/` (Vite + React + Tailwind), `desktop/` (Electron shell around `web/` — signed + notarized macOS build), `mobile/` (Expo), `shared/`, plus tests and deploy config. |
| `centaur/` | the agent runtime — **our fork of `paradigmxyz/centaur`**, vendored via `git subtree`. Rust + Python + Helm; self-contained (`just`, cargo). See [`centaur/ATRIUM_FORK.md`](centaur/ATRIUM_FORK.md). |
| `infra/` | local cluster, a stand-in model server for testing, and deployment setup. |
| `docs/` | public documentation entry points. |
| `docs/archive/notes/` | archived design scratchpads and build logs from early development; useful context, not canonical user docs. |

## Links

- **Architecture walkthrough:** https://gbasin.github.io/atrium-architecture/
- **UI surfaces:** the screens and how they compose — [docs/surfaces.md](docs/surfaces.md).
- **Desktop app:** build, signing, and auto-update — [surface/desktop/README.md](surface/desktop/README.md).
- **Agent engine:** our Centaur fork in [`centaur/`](centaur/) — upstream [paradigmxyz/centaur](https://github.com/paradigmxyz/centaur) (Apache-2.0 OR MIT), pulled via subtree (see [`centaur/ATRIUM_FORK.md`](centaur/ATRIUM_FORK.md)).
- **Contributing:** branch and PR/merge flow in [CONTRIBUTING.md](CONTRIBUTING.md).
- **Security:** report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
- **License:** Atrium is AGPL-3.0-or-later; vendored Centaur remains Apache-2.0 OR MIT. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [centaur/LICENSE](centaur/LICENSE).
