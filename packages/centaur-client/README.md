# @atrium/centaur-client

Typed TypeScript client for the Centaur agent control-plane API plus a reducer for the durable event stream observed in Atrium Phase 0.

```ts
import {
  CentaurClient,
  initialSessionState,
  reduceSession,
} from "@atrium/centaur-client";

const client = new CentaurClient({
  baseUrl: "http://127.0.0.1:18000",
  apiKey: process.env.CENTAUR_API_KEY!,
});

const spawn = await client.spawn("thread-123", "claude-code");
await client.postMessage(
  "thread-123",
  spawn.assignment_generation,
  [{ type: "text", text: "Reply with exactly PONG." }],
  { user_name: "Gary", platform: "dev" },
);

const execution = await client.execute(
  "thread-123",
  spawn.assignment_generation,
  "claude-code",
);

let state = initialSessionState();
for await (const frame of client.tailEvents("thread-123", {
  executionId: execution.execution_id,
  afterEventId: state.lastEventId,
})) {
  state = reduceSession(state, frame);
}
```

Render content from `amp_raw_event` frames. Projection text events are metadata only and the reducer intentionally ignores them for transcript content to avoid double rendering.
