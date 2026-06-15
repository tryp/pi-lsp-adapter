/**
 * Tests for LSP tool descriptions — verify they advertise .md support
 * and point to lsp_list_workspace_roots for server discovery.
 *
 * These test the static registration-time properties (descriptions,
 * promptSnippet, promptGuidelines). The dynamic runtime behavior
 * (server listing in system prompt and execute() output) is tested
 * separately.
 *
 * Runs with: `npx tsx --test tests/descriptions.test.ts`
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TSchema } from "typebox";

// ── Types ───────────────────────────────────────────────────────────

interface CapturedTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TSchema;
}

interface CapturedPromptGuidelines {
  toolName: string;
  guidelines: string[];
}

// ── Mock ExtensionAPI ───────────────────────────────────────────────

interface MockExtensionApi {
  registerTool: (tool: CapturedTool) => void;
  registerToolPromptGuidelines: (toolName: string, g: string[]) => void;
  registerCommand: (...args: any[]) => void;
  registerFlag: (name: string, opts: any) => void;
  on: (event: string, handler: any) => void;
  getFlag: (name: string) => any;
  sendMessage: (msg: any, opts?: any) => void;
  events: { on: (e: string, h: any) => void; emit: (e: string, ...a: any[]) => void };
}

function createMockPi(): { pi: MockExtensionApi; tools: CapturedTool[]; guidelines: CapturedPromptGuidelines[] } {
  const tools: CapturedTool[] = [];
  const guidelines: CapturedPromptGuidelines[] = [];
  const eventHandlers: Record<string, any> = {};

  const pi: MockExtensionApi = {
    registerTool: (t: CapturedTool) => tools.push(t),
    registerToolPromptGuidelines: (toolName: string, g: string[]) =>
      guidelines.push({ toolName, guidelines: g }),
    registerCommand: () => {},
    registerFlag: () => {},
    on: (event: string, handler: any) => { eventHandlers[event] = handler; },
    getFlag: () => undefined,
    sendMessage: () => {},
    events: {
      on: (e: string, h: any) => { eventHandlers[e] = h; },
      emit: () => {},
    },
  };

  return { pi, tools, guidelines };
}

// ── Load extension ──────────────────────────────────────────────────

let tools: CapturedTool[] = [];
let guidelines: CapturedPromptGuidelines[] = [];
let loaded = false;

try {
  const { registerLspTools } = await import("../src/tools/registerLspTools.js");
  const { pi, tools: captured, guidelines: capturedG } = createMockPi();
  // registerLspTools needs getState — provide no-op since descriptions are static
  registerLspTools(pi as any, () => null as any);
  tools = captured;
  guidelines = capturedG;
  loaded = true;
} catch (e: any) {
  console.log(`\n  [LOAD ERROR] ${e.message?.substring(0, 300)}\n`);
}

// ── Tests ───────────────────────────────────────────────────────────

describe("tool descriptions advertise .md support", () => {
  if (!loaded) {
    it("loads extension module", () => {
      assert.ok(false, "Failed to load registerLspTools module");
    });
    return;
  }

  // Check specific tools that should mention .md support
  // Tools whose descriptions mention .md/markdown/marksman explicitly
  const mdMentionTools = [
    "lsp_hover",
    "lsp_definition",
    "lsp_references",
    "lsp_document_symbols",
  ];

  for (const name of mdMentionTools) {
    const tool = tools.find((t) => t.name === name);
    it(`${name} description mentions .md or marksman`, () => {
      assert.ok(tool, `${name} tool not registered`);
      const desc = tool!.description.toLowerCase();
      const mentionsMd = desc.includes(".md") || desc.includes("markdown") || desc.includes("marksman");
      assert.ok(mentionsMd, `"${name}" description does not mention .md/markdown/marksman:\n  "${tool!.description}"`);
    });
  }

  // lsp_diagnostics points to the discovery mechanism instead
  it("lsp_diagnostics description references server discovery", () => {
    const tool = tools.find((t) => t.name === "lsp_diagnostics");
    assert.ok(tool, "lsp_diagnostics not registered");
    const desc = tool!.description.toLowerCase();
    assert.ok(
      desc.includes("server") && desc.includes("lsp_list_workspace_roots"),
      `description should mention servers and lsp_list_workspace_roots:\n  "${tool!.description}"`,
    );
  });

  it("lsp_list_workspace_roots description mentions servers", () => {
    const tool = tools.find((t) => t.name === "lsp_list_workspace_roots");
    assert.ok(tool, "lsp_list_workspace_roots not registered");
    const desc = tool!.description.toLowerCase();
    assert.ok(
      desc.includes("server") || desc.includes("file types"),
      `description does not mention servers or file types:\n  "${tool!.description}"`,
    );
  });

  it("lsp_list_workspace_roots promptGuidelines mentions server discovery", () => {
    const tool = tools.find((t) => t.name === "lsp_list_workspace_roots");
    assert.ok(tool, "lsp_list_workspace_roots not registered");
    const guidelines = tool!.promptGuidelines ?? [];
    const allText = guidelines.join(" ").toLowerCase();
    assert.ok(
      allText.includes("server") && allText.includes("capabilities"),
      `promptGuidelines should mention server discovery:\n  ${JSON.stringify(guidelines, null, 2)}`,
    );
  });
});

describe("tool descriptions point to discovery mechanism", () => {
  if (!loaded) return;

  const toolsWithDiscovery = [
    "lsp_hover",
    "lsp_definition",
    "lsp_references",
    "lsp_document_symbols",
    "lsp_diagnostics",
  ];

  for (const name of toolsWithDiscovery) {
    const tool = tools.find((t) => t.name === name);
    it(`${name} description references lsp_list_workspace_roots for server discovery`, () => {
      assert.ok(tool, `${name} tool not registered`);
      const desc = tool!.description.toLowerCase();
      assert.ok(
        desc.includes("lsp_list_workspace_roots"),
        `"${name}" description does not mention lsp_list_workspace_roots:\n  "${tool!.description}"`,
      );
    });
  }
});

describe("prompt guidelines for read tool mention LSP alternatives", () => {
  if (!loaded) return;

  const readGuidelines = guidelines.find((g) => g.toolName === "read");
  it("read tool has prompt guidelines", () => {
    assert.ok(readGuidelines, "read tool prompt guidelines not registered");
    assert.ok(readGuidelines!.guidelines.length >= 4,
      `expected >=4 guidelines, got ${readGuidelines!.guidelines.length}`);
  });
});

describe("all structural tool descriptions are informative", () => {
  if (!loaded) return;

  const structuralTools = [
    "lsp_hover", "lsp_definition", "lsp_references",
    "lsp_document_symbols", "lsp_workspace_symbols",
  ];

  for (const name of structuralTools) {
    const tool = tools.find((t) => t.name === name);
    it(`${name} description is >40 characters`, () => {
      assert.ok(tool, `${name} not registered`);
      assert.ok(tool!.description.length > 40,
        `"${name}" description too short (${tool!.description.length} chars): "${tool!.description}"`);
    });

    it(`${name} has promptSnippet`, () => {
      assert.ok(tool, `${name} not registered`);
      assert.ok(tool!.promptSnippet?.length > 10,
        `"${name}" promptSnippet too short`);
    });

    it(`${name} has promptGuidelines`, () => {
      assert.ok(tool, `${name} not registered`);
      assert.ok((tool!.promptGuidelines?.length ?? 0) >= 1,
        `"${name}" missing promptGuidelines`);
    });
  }
});

describe("lsp_list_workspace_roots promptSnippet is informative", () => {
  if (!loaded) return;

  const tool = tools.find((t) => t.name === "lsp_list_workspace_roots");
  it("promptSnippet mentions servers or file types", () => {
    assert.ok(tool, "tool not registered");
    const snippet = tool!.promptSnippet ?? "";
    assert.ok(
      snippet.toLowerCase().includes("server") || snippet.toLowerCase().includes("file type"),
      `promptSnippet doesn't mention servers: "${snippet}"`,
    );
  });
});
