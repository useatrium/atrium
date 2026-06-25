#!/usr/bin/env node

/*
 * Deferred: per-sandbox scoped credentials via the token-broker, and
 * resources/list of a session's entries.
 *
 * Comments are authored as the configured token's principal; tagging them
 * actor='agent' distinctly is a deferred refinement.
 */

import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  loadConfig,
  postEntryComment,
  postEntryReaction,
  readEntryResource,
} from "./client.js";

const cfg = loadConfig(process.env);
const server = new McpServer({
  name: "atrium-mcp",
  version: "0.1.0",
});

server.registerResource(
  "atrium-entry",
  new ResourceTemplate("atrium://entry/{handle}", { list: undefined }),
  {
    title: "Atrium Entry",
    description: "Dereference an Atrium entry by universal handle.",
    mimeType: "application/json",
  },
  async (_uri, variables) => {
    const handle = singleVariable(variables.handle, "handle");
    return readEntryResource(handle, cfg);
  },
);

server.registerTool(
  "entries.comment",
  {
    title: "Comment on Atrium Entry",
    description: "Post a comment on an Atrium entry by universal handle.",
    inputSchema: {
      handle: z.string(),
      text: z.string(),
    },
  },
  async ({ handle, text }) => {
    try {
      await postEntryComment(handle, text, cfg);
      return toolText("comment posted");
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "entries.react",
  {
    title: "React to Atrium Entry",
    description: "Add or remove an emoji reaction on an Atrium entry by universal handle.",
    inputSchema: {
      handle: z.string(),
      emoji: z.string(),
      action: z.enum(["add", "remove"]),
    },
  },
  async ({ handle, emoji, action }) => {
    try {
      await postEntryReaction(handle, emoji, action, cfg);
      return toolText("reaction posted");
    } catch (error) {
      return toolError(error);
    }
  },
);

await server.connect(new StdioServerTransport());

function singleVariable(value: string | string[] | undefined, name: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Error(`Missing or invalid resource variable ${name}`);
}

function toolText(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function toolError(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true as const,
  };
}
