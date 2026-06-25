/*
 * Deferred: per-sandbox scoped credentials via the token-broker, and
 * resources/list of a session's entries.
 */

export interface AtriumMcpConfig {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface EntryResourceReadResult {
  [key: string]: unknown;
  contents: [
    {
      uri: string;
      mimeType: "application/json";
      text: string;
    },
  ];
}

export type EntryReactionAction = "add" | "remove";

export interface EntryWriteResult {
  ok: true;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): AtriumMcpConfig {
  const baseUrl = requiredEnv(env, "ATRIUM_BASE_URL");
  const token = requiredEnv(env, "ATRIUM_TOKEN");

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token,
  };
}

export async function readEntryResource(
  handle: string,
  cfg: AtriumMcpConfig,
): Promise<EntryResourceReadResult> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const baseUrl = cfg.baseUrl.replace(/\/+$/, "");
  const response = await fetchImpl(
    `${baseUrl}/api/entries/${encodeURIComponent(handle)}`,
    {
      headers: {
        Authorization: `Bearer ${cfg.token}`,
      },
    },
  );

  if (response.status === 404) {
    throw new Error("entry not found or not accessible");
  }

  if (!response.ok) {
    throw new Error(`Atrium entry read failed with status ${response.status}`);
  }

  return {
    contents: [
      {
        uri: `atrium://entry/${handle}`,
        mimeType: "application/json",
        text: await response.text(),
      },
    ],
  };
}

export async function postEntryComment(
  handle: string,
  text: string,
  cfg: AtriumMcpConfig,
): Promise<EntryWriteResult> {
  return postEntryAnnotation(handle, "comments", { text }, "comment", cfg);
}

export async function postEntryReaction(
  handle: string,
  emoji: string,
  action: EntryReactionAction,
  cfg: AtriumMcpConfig,
): Promise<EntryWriteResult> {
  return postEntryAnnotation(handle, "reactions", { emoji, action }, "reaction", cfg);
}

function requiredEnv(env: Env, name: "ATRIUM_BASE_URL" | "ATRIUM_TOKEN"): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }

  return value;
}

async function postEntryAnnotation(
  handle: string,
  path: "comments" | "reactions",
  body: Record<string, string>,
  operation: "comment" | "reaction",
  cfg: AtriumMcpConfig,
): Promise<EntryWriteResult> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const baseUrl = cfg.baseUrl.replace(/\/+$/, "");
  const response = await fetchImpl(
    `${baseUrl}/api/entries/${encodeURIComponent(handle)}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (response.status === 404) {
    throw new Error("entry not found or not accessible");
  }

  if (!response.ok) {
    throw new Error(`Atrium entry ${operation} failed with status ${response.status}`);
  }

  return { ok: true };
}
