import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "../../src/index.js";

type Handler = (event: unknown, ctx: FakeContext) => Promise<unknown> | unknown;

interface CommandHandler {
  description?: string;
  handler: (args: string, ctx: FakeContext) => Promise<void> | void;
}

interface ToolHandler {
  name: string;
}

interface FakeContext {
  cwd: string;
  hasUI: boolean;
  ui: {
    theme: { fg: (_name: string, text: string) => string };
    notifications: Array<{ message: string; level: string }>;
    statuses: Record<string, string | undefined>;
    notify: (message: string, level: string) => void;
    setStatus: (key: string, value: string | undefined) => void;
    confirm: () => Promise<boolean>;
  };
}

let originalHome: string | undefined;
let tempHome: string;
let tempProject: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(join(tmpdir(), "pi-lsp-index-home-"));
  tempProject = await mkdtemp(join(tmpdir(), "pi-lsp-index-project-"));
  process.env.HOME = tempHome;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(tempHome, { recursive: true, force: true });
  await rm(tempProject, { recursive: true, force: true });
});

describe("extension entrypoint", () => {
  it("registers /lsp and initializes lifecycle state on session_start", async () => {
    const pi = fakePi();
    extension(pi.api);

    expect(pi.commands.has("lsp")).toBe(true);
    expect(pi.tools.has("lsp_diagnostics")).toBe(true);
    expect(pi.handlers.has("before_agent_start")).toBe(true);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);

    const ctx = fakeContext();
    await pi.handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await pi.commands.get("lsp")?.handler("status", ctx);
    const beforeAgent = await pi.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx);

    expect(ctx.ui.statuses.lsp).toMatch(/LSP: 0\/\d+ servers/u);
    expect(ctx.ui.notifications.at(-1)?.message).toContain("LSP status");
    expect(beforeAgent).toMatchObject({ systemPrompt: expect.stringContaining("EFFICIENCY RULES") });

    await pi.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
    expect(ctx.ui.statuses.lsp).toBeUndefined();
  });

  it("keeps the catalog-independent guidance when a prompt beats session_start initialization", async () => {
    const pi = fakePi();
    extension(pi.api);
    const ctx = fakeContext();

    // No session_start yet: this is what a first prompt sees when it wins the race
    // against session_start's async config load.
    const early = (await pi.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx)) as {
      systemPrompt: string;
    };
    // The guidance does not depend on that load, so losing it would cost the whole
    // epoch its LSP instructions for no reason.
    expect(early.systemPrompt.startsWith("base\n\n")).toBe(true);
    expect(early.systemPrompt).toContain("**EFFICIENCY RULES (follow strictly):**");
    expect(early.systemPrompt).toContain("**Cross-project analysis:**");
    // The catalog-derived half would be a guess before the config has been read, so
    // it must be absent rather than empty-but-claimed.
    expect(early.systemPrompt).not.toContain("Available LSP servers");

    await pi.handlers.get("session_start")?.({ reason: "startup" }, ctx);
    const configured = Number(ctx.ui.statuses.lsp?.match(/LSP: \d+\/(\d+) servers/u)?.[1] ?? "0");
    expect(configured).toBeGreaterThan(0);

    const later = (await pi.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx)) as {
      systemPrompt: string;
    };
    expect(later.systemPrompt).toContain("Available LSP servers");
    // The summary is appended after byte-identical guidance, so the only difference
    // between the two prompts is the part that needed the config.
    expect(later.systemPrompt.startsWith(early.systemPrompt.slice(0, -1))).toBe(true);

    await pi.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  });
});

function fakePi(): {
  api: never;
  handlers: Map<string, Handler>;
  commands: Map<string, CommandHandler>;
  tools: Map<string, ToolHandler>;
} {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, CommandHandler>();
  const tools = new Map<string, ToolHandler>();
  return {
    handlers,
    commands,
    tools,
    api: {
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      registerCommand: (name: string, command: CommandHandler) => commands.set(name, command),
      registerTool: (tool: ToolHandler) => tools.set(tool.name, tool),
      registerToolPromptGuidelines: () => {},
      registerFlag: () => {},
    } as never,
  };
}

function fakeContext(): FakeContext {
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Record<string, string | undefined> = {};
  return {
    cwd: tempProject,
    hasUI: true,
    ui: {
      notifications,
      statuses,
      theme: { fg: (_name: string, text: string) => text },
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setStatus: (key: string, value: string | undefined) => {
        statuses[key] = value;
      },
      confirm: async () => true,
    },
  };
}
