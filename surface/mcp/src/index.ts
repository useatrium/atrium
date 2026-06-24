#!/usr/bin/env node

/*
 * Deferred: per-sandbox scoped credentials via the token-broker, and
 * resources/list of a session's entries.
 */

import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, readEntryResource } from "./client.js";

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

await server.connect(new StdioServerTransport());

function singleVariable(value: string | string[] | undefined, name: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Error(`Missing or invalid resource variable ${name}`);
}
