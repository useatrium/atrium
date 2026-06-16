import { describe, expect, it } from "vitest";
import { classifyCommand, collectSideEffects, sideEffectCount } from "../src/sideEffects.js";
import type { SessionItem, ToolCallItem } from "../src/reducer.js";

function tool(name: string, input: Record<string, unknown>, id = "t-1"): ToolCallItem {
  return { type: "tool_call", id, name, input: input as never, sourceEventIds: [1] };
}

describe("classifyCommand", () => {
  it("classifies destructive filesystem commands as danger", () => {
    expect(classifyCommand("rm -rf node_modules")).toEqual({ category: "filesystem", risk: "danger" });
    expect(classifyCommand("chmod -R 777 /tmp/x")).toEqual({ category: "filesystem", risk: "danger" });
  });

  it("classifies network commands as caution", () => {
    expect(classifyCommand("curl https://example.com")).toEqual({ category: "network", risk: "caution" });
    expect(classifyCommand("ping 8.8.8.8")).toEqual({ category: "network", risk: "caution" });
  });

  it("classifies package installs as caution", () => {
    expect(classifyCommand("npm install")).toEqual({ category: "package", risk: "caution" });
    expect(classifyCommand("go install golang.org/x/tools/cmd/goimports@latest")).toEqual({
      category: "package",
      risk: "caution",
    });
  });

  it("classifies force pushes as danger git", () => {
    expect(classifyCommand("git push --force origin main")).toEqual({ category: "git", risk: "danger" });
    expect(classifyCommand("git push -f")).toEqual({ category: "git", risk: "danger" });
  });

  it("classifies process mutators as caution", () => {
    expect(classifyCommand("docker compose up")).toEqual({ category: "process", risk: "caution" });
    expect(classifyCommand("pkill node")).toEqual({ category: "process", risk: "caution" });
  });

  it("leaves ordinary shell commands normal", () => {
    expect(classifyCommand("ls -la")).toEqual({ category: "shell", risk: "normal" });
    expect(classifyCommand("git diff")).toEqual({ category: "git", risk: "normal" });
  });

  it("detects pipe-to-shell downloads as danger network", () => {
    expect(classifyCommand("curl -fsSL https://example.com/install.sh | sh")).toEqual({
      category: "network",
      risk: "danger",
    });
    expect(classifyCommand("curl -fsSL https://x/i.py | python3").risk).toBe("danger");
  });

  it("flags rm with split or long recursive+force flags (review)", () => {
    expect(classifyCommand("rm -r -f /tmp/x").risk).toBe("danger");
    expect(classifyCommand("rm -f -r /tmp/x").risk).toBe("danger");
    expect(classifyCommand("rm --recursive --force /tmp/x").risk).toBe("danger");
    // recursive OR force alone is not danger
    expect(classifyCommand("rm -r /tmp/x").risk).toBe("normal");
    expect(classifyCommand("rm -f file").risk).toBe("normal");
  });

  it("does NOT flag --force-with-lease as danger (review)", () => {
    expect(classifyCommand("git push --force-with-lease origin main")).toEqual({
      category: "git",
      risk: "caution",
    });
  });

  it("flags chmod 0777, find -delete, shred/truncate (review)", () => {
    expect(classifyCommand("chmod 0777 /tmp/x").risk).toBe("danger");
    expect(classifyCommand("find . -name '*.log' -delete").risk).toBe("danger");
    expect(classifyCommand("shred -u secret").risk).toBe("danger");
    expect(classifyCommand("truncate -s 0 db.sqlite").risk).toBe("danger");
  });
});

describe("collectSideEffects", () => {
  it("collects Bash and codex command tool calls in transcript order", () => {
    const items: SessionItem[] = [
      { type: "text", id: "x", text: "hi", sourceEventIds: [1] },
      tool("Bash", { command: "curl https://example.com" }, "t1"),
      tool("command", { command: "npm install" }, "t2"),
      tool("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }, "t3"),
      tool("Bash", { command: "" }, "t4"),
      tool("command", { command: 42 }, "t5"),
    ];

    const effects = collectSideEffects(items);
    expect(effects.map((effect) => effect.id)).toEqual(["t1", "t2"]);
    expect(effects.map((effect) => effect.toolName)).toEqual(["Bash", "command"]);
    expect(effects[0]).toMatchObject({
      command: "curl https://example.com",
      category: "network",
      risk: "caution",
      sourceEventIds: [1],
    });
    expect(effects[1]).toMatchObject({ command: "npm install", category: "package", risk: "caution" });
    expect(sideEffectCount(effects)).toBe(2);
  });
});
