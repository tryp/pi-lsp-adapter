import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerLspTools } from "../../src/tools/registerLspTools.js";
import type { LspExtensionState } from "../../src/state.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

type Tool = {
  name: string;
  parameters?: unknown;
  promptGuidelines?: string[];
  execute: (toolCallId: string, params: never) => Promise<ToolResult>;
};

let tempHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(join(tmpdir(), "pi-lsp-tools-home-"));
  process.env.HOME = tempHome;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(tempHome, { recursive: true, force: true });
});

function fakePi(): { api: never; tools: Map<string, Tool> } {
  const tools = new Map<string, Tool>();
  return {
    tools,
    api: {
      registerTool: (tool: Tool) => tools.set(tool.name, tool),
      registerToolPromptGuidelines: () => {},
      registerFlag: () => {}, registerCommands: () => {},
      on: () => {},
    } as never,
  };
}

function fakeState(runtime: Partial<LspExtensionState["runtimeManager"]> = {}): LspExtensionState {
  return {
    ownerId: "test",
    cwd: tempHome,
    config: {
      catalog: { servers: {} },
      warnings: [],
      installMode: "auto",
      warmup: true,
      autoWorkspaceRoots: [],
      autoWorkspaceRootMode: "trusted",
    },
    installManager: {} as never,
    processRegistry: {} as never,
    runtimeManager: {
      diagnostics: async () => ({
        serverId: "vtsls",
        rootDir: tempHome,
        filePath: join(tempHome, "index.ts"),
        uri: `file://${join(tempHome, "index.ts")}`,
        diagnostics: [],
      }),
      hover: async () => ({
        serverId: "vtsls",
        rootDir: tempHome,
        filePath: join(tempHome, "index.ts"),
        uri: `file://${join(tempHome, "index.ts")}`,
        result: { contents: { kind: "markdown", value: "hover result" } },
      }),
      definition: async () => ({
        serverId: "vtsls",
        rootDir: tempHome,
        filePath: join(tempHome, "index.ts"),
        uri: `file://${join(tempHome, "index.ts")}`,
        result: [
          {
            uri: `file://${join(tempHome, "def.ts")}`,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          },
        ],
      }),
      references: async () => ({
        serverId: "vtsls",
        rootDir: tempHome,
        filePath: join(tempHome, "index.ts"),
        uri: `file://${join(tempHome, "index.ts")}`,
        result: [
          {
            uri: `file://${join(tempHome, "ref.ts")}`,
            range: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } },
          },
        ],
      }),
      documentSymbols: async () => ({
        serverId: "vtsls",
        rootDir: tempHome,
        filePath: join(tempHome, "index.ts"),
        uri: `file://${join(tempHome, "index.ts")}`,
        result: [
          {
            name: "MyClass",
            kind: 5,
            range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
            selectionRange: { start: { line: 0, character: 5 }, end: { line: 0, character: 12 } },
            children: [
              {
                name: "myMethod",
                kind: 6,
                range: { start: { line: 1, character: 0 }, end: { line: 5, character: 0 } },
                selectionRange: { start: { line: 1, character: 8 }, end: { line: 1, character: 16 } },
                children: [],
              },
            ],
          },
        ],
      }),
      workspaceSymbols: async () => [
        {
          serverId: "vtsls",
          rootDir: tempHome,
          result: [
            {
              name: "MyClass",
              kind: 5,
              location: {
                uri: `file://${join(tempHome, "index.ts")}`,
                range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
              },
            },
          ],
        },
      ],
      ...runtime,
    } as never,
    resultCache: { store: () => undefined, next: () => ({ content: [{ type: "text" as const, text: "" }] }) } as never,
  };
}

describe("LSP tool integration", () => {
  it("lsp_diagnostics executes and returns formatted result", async () => {
    const pi = fakePi();
    registerLspTools(pi.api, () => fakeState());

    const result = await pi.tools.get("lsp_diagnostics")?.execute("tool-1", {
      filePath: join(tempHome, "index.ts"),
    } as never);

    expect(result?.content[0]?.text).toContain("No LSP diagnostics");
  });

  it("lsp_diagnostics returns failure when not initialized", async () => {
    const pi = fakePi();
    registerLspTools(pi.api, () => null);

    const result = await pi.tools.get("lsp_diagnostics")?.execute("tool-1", {
      filePath: "a.ts",
    } as never);

    expect(result?.content[0]?.text).toContain("LSP extension is not initialized");
  });

  it("lsp_definition executes and returns formatted result", async () => {
    const pi = fakePi();
    registerLspTools(pi.api, () => fakeState());

    const result = await pi.tools.get("lsp_definition")?.execute("tool-1", {
      filePath: join(tempHome, "index.ts"),
      line: 1,
      column: 1,
    } as never);

    expect(result?.content[0]?.text).toContain("LSP definition");
  });

  it("lsp_references executes and returns formatted result", async () => {
    const pi = fakePi();
    registerLspTools(pi.api, () => fakeState());

    const result = await pi.tools.get("lsp_references")?.execute("tool-1", {
      filePath: join(tempHome, "index.ts"),
      line: 1,
      column: 1,
    } as never);

    expect(result?.content[0]?.text).toContain("LSP reference");
  });

  it("lsp_references with includeDeclaration", async () => {
    const pi = fakePi();
    registerLspTools(pi.api, () => fakeState());

    const result = await pi.tools.get("lsp_references")?.execute("tool-1", {
      filePath: join(tempHome, "index.ts"),
      line: 1,
      column: 1,
      includeDeclaration: true,
    } as never);

    expect(result?.content[0]?.text).toContain("LSP reference");
  });

  it("lsp_document_symbols executes and returns formatted result", async () => {
    const pi = fakePi();
    registerLspTools(pi.api, () => fakeState());

    const result = await pi.tools.get("lsp_document_symbols")?.execute("tool-1", {
      filePath: join(tempHome, "index.ts"),
    } as never);

    expect(result?.content[0]?.text).toContain("LSP document symbols");
    expect(result?.content[0]?.text).toContain("MyClass");
    expect(result?.content[0]?.text).toContain("myMethod");
  });

  it("lsp_workspace_symbols executes and returns formatted result", async () => {
    const pi = fakePi();
    registerLspTools(pi.api, () => fakeState());

    const result = await pi.tools.get("lsp_workspace_symbols")?.execute("tool-1", {
      query: "MyClass",
    } as never);

    expect(result?.content[0]?.text).toContain("LSP workspace symbols");
    expect(result?.content[0]?.text).toContain("MyClass");
  });

  it("lsp_workspace_symbols with serverId filter", async () => {
    const pi = fakePi();
    registerLspTools(pi.api, () => fakeState());

    const result = await pi.tools.get("lsp_workspace_symbols")?.execute("tool-1", {
      query: "MyClass",
      serverId: "vtsls",
    } as never);

    expect(result?.content[0]?.text).toContain("LSP workspace symbols");
  });

  it("lsp_hover returns failure when not initialized", async () => {
    const pi = fakePi();
    registerLspTools(pi.api, () => null);

    const result = await pi.tools.get("lsp_hover")?.execute("tool-1", {
      filePath: "a.ts",
      line: 1,
      column: 1,
    } as never);

    expect(result?.content[0]?.text).toContain("LSP extension is not initialized");
  });

  it("lsp_definition returns failure when not initialized", async () => {
    const pi = fakePi();
    registerLspTools(pi.api, () => null);

    const result = await pi.tools.get("lsp_definition")?.execute("tool-1", {
      filePath: "a.ts",
      line: 1,
      column: 1,
    } as never);

    expect(result?.content[0]?.text).toContain("LSP extension is not initialized");
  });

  it("lsp_document_symbols returns failure when not initialized", async () => {
    const pi = fakePi();
    registerLspTools(pi.api, () => null);

    const result = await pi.tools.get("lsp_document_symbols")?.execute("tool-1", {
      filePath: "a.ts",
    } as never);

    expect(result?.content[0]?.text).toContain("LSP extension is not initialized");
  });

  it("lsp_workspace_symbols returns failure when not initialized", async () => {
    const pi = fakePi();
    registerLspTools(pi.api, () => null);

    const result = await pi.tools.get("lsp_workspace_symbols")?.execute("tool-1", {
      query: "test",
    } as never);

    expect(result?.content[0]?.text).toContain("LSP extension is not initialized");
  });

  it("lsp_add_workspace_root returns a content-bearing result", async () => {
    const pi = fakePi();
    const state = fakeState({
      addWorkspaceRoot: async () => ({ added: true, resolved: join(tempHome, "ext") }),
    });
    registerLspTools(pi.api, () => state);

    const result = await pi.tools.get("lsp_add_workspace_root")?.execute("tool-1", {
      directory: join(tempHome, "ext"),
    } as never);

    expect(Array.isArray(result?.content)).toBe(true);
    expect(result?.content[0]?.text).toContain("Added");
    expect(result?.content[0]?.text).toContain("LSP workspace scope");
  });

  it("lsp_add_workspace_root returns an already-in-scope result", async () => {
    const pi = fakePi();
    const state = fakeState({
      addWorkspaceRoot: async () => ({ added: false, resolved: join(tempHome, "ext") }),
    });
    registerLspTools(pi.api, () => state);

    const result = await pi.tools.get("lsp_add_workspace_root")?.execute("tool-1", {
      directory: join(tempHome, "ext"),
    } as never);

    expect(Array.isArray(result?.content)).toBe(true);
    expect(result?.content[0]?.text).toContain("already in LSP workspace scope");
  });

  it("lsp_add_workspace_root returns failure when not initialized", async () => {
    const pi = fakePi();
    registerLspTools(pi.api, () => null);

    const result = await pi.tools.get("lsp_add_workspace_root")?.execute("tool-1", {
      directory: join(tempHome, "ext"),
    } as never);

    expect(result?.content[0]?.text).toContain("LSP extension is not initialized");
  });

  it("lsp_list_workspace_roots returns a content-bearing result", async () => {
    const pi = fakePi();
    const state = fakeState({
      listWorkspaceRoots: () => [tempHome],
      activeClients: () => [],
    });
    registerLspTools(pi.api, () => state);

    const result = await pi.tools.get("lsp_list_workspace_roots")?.execute("tool-1", {} as never);

    expect(Array.isArray(result?.content)).toBe(true);
    expect(result?.content[0]?.text).toContain("LSP workspace roots");
  });

  it("lsp_list_workspace_roots returns failure when not initialized", async () => {
    const pi = fakePi();
    registerLspTools(pi.api, () => null);

    const result = await pi.tools.get("lsp_list_workspace_roots")?.execute("tool-1", {} as never);

    expect(result?.content[0]?.text).toContain("LSP extension is not initialized");
  });
});
