import { describe, expect, it } from "vitest";

import { loadConfig, readEntryResource, type AtriumMcpConfig } from "../src/client.js";

describe("readEntryResource", () => {
  it("returns the JSON response body as a single application/json content", async () => {
    const calls: Array<{
      input: Parameters<typeof fetch>[0];
      init: Parameters<typeof fetch>[1];
    }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response('{"handle":"foo/bar baz"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await readEntryResource("foo/bar baz", {
      baseUrl: "https://atrium.example/",
      token: "test-token",
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe(
      "https://atrium.example/api/entries/foo%2Fbar%20baz",
    );
    expect(calls[0]?.init?.headers).toEqual({
      Authorization: "Bearer test-token",
    });
    expect(result).toEqual({
      contents: [
        {
          uri: "atrium://entry/foo/bar baz",
          mimeType: "application/json",
          text: '{"handle":"foo/bar baz"}',
        },
      ],
    });
  });

  it("throws a not found error on 404", async () => {
    await expect(
      readEntryResource("missing", configWithStatus(404)),
    ).rejects.toThrow("entry not found or not accessible");
  });

  it("throws with the response status on other non-2xx responses", async () => {
    await expect(
      readEntryResource("broken", configWithStatus(500)),
    ).rejects.toThrow("500");
  });
});

describe("loadConfig", () => {
  it("loads required environment variables", () => {
    expect(
      loadConfig({
        ATRIUM_BASE_URL: "https://atrium.example/",
        ATRIUM_TOKEN: "test-token",
      }),
    ).toEqual({
      baseUrl: "https://atrium.example",
      token: "test-token",
    });
  });

  it("throws when ATRIUM_BASE_URL is missing", () => {
    expect(() => loadConfig({ ATRIUM_TOKEN: "test-token" })).toThrow(
      "ATRIUM_BASE_URL",
    );
  });

  it("throws when ATRIUM_TOKEN is missing", () => {
    expect(() => loadConfig({ ATRIUM_BASE_URL: "https://atrium.example" })).toThrow(
      "ATRIUM_TOKEN",
    );
  });
});

function configWithStatus(status: number): AtriumMcpConfig {
  return {
    baseUrl: "https://atrium.example",
    token: "test-token",
    fetchImpl: async () => new Response("", { status }),
  };
}
