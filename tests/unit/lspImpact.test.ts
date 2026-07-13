import { describe, expect, it } from "vitest";
import {
  isTestFile,
  symbolKey,
  formatAmbiguity,
  resolveSymbols,
  analyzeImpact,
} from "../../src/tools/lspImpact.js";
import { formatImpact } from "../../src/tools/lspFormat.js";
import type { ResolvedSymbol, SymbolInput } from "../../src/tools/lspImpact.js";
import type { LspRuntimeManager } from "../../src/lsp/runtimeManager.js";
import type {
  CallHierarchyIncomingCall,
  DocumentSymbol,
  Location,
  SymbolInformation,
} from "vscode-languageserver-types";
import { SymbolKind } from "vscode-languageserver-protocol";

// ─── Mock helpers ───────────────────────────────────────────────────────

function mockRuntimeManager(overrides?: Partial<LspRuntimeManager>): LspRuntimeManager {
  return {
    cwd: "/repo",
    workspaceRoots: ["/repo"],
    hover: async () => ({
      serverId: "vtsls",
      rootDir: "/repo",
      filePath: "",
      uri: "file:///repo/src/index.ts",
      result: null,
    }),
    documentSymbols: async () => ({
      serverId: "vtsls",
      rootDir: "/repo",
      filePath: "",
      uri: "",
      result: null,
    }),
    workspaceSymbols: async () => [],
    references: async () => ({
      serverId: "vtsls",
      rootDir: "/repo",
      filePath: "",
      uri: "",
      result: null,
    }),
    callHierarchy: async () => ({
      serverId: "vtsls",
      rootDir: "/repo",
      filePath: "",
      uri: "",
      result: null,
    }),
    ...overrides,
  } as unknown as LspRuntimeManager;
}

function loc(
  uri: string,
  startLine: number,
  startCol: number,
  endLine?: number,
  endCol?: number,
): Location {
  return {
    uri,
    range: {
      start: { line: startLine, character: startCol },
      end: { line: endLine ?? startLine, character: endCol ?? startCol },
    },
  };
}

// ─── isTestFile ─────────────────────────────────────────────────────────

describe("isTestFile", () => {
  it("detects _test.py files", () => {
    expect(isTestFile("/repo/tests/test_utils.py")).toBe(true);
    expect(isTestFile("/repo/src/utils_test.py")).toBe(true);
  });

  it("detects .test.ts files", () => {
    expect(isTestFile("/repo/src/foo.test.ts")).toBe(true);
    expect(isTestFile("/repo/src/foo.test.tsx")).toBe(true);
  });

  it("detects .spec.ts files", () => {
    expect(isTestFile("/repo/src/foo.spec.ts")).toBe(true);
    expect(isTestFile("/repo/src/foo.spec.js")).toBe(true);
  });

  it("detects __tests__ directories", () => {
    expect(isTestFile("/repo/__tests__/foo.ts")).toBe(true);
  });

  it("detects /tests/ directory paths", () => {
    expect(isTestFile("/repo/tests/foo.ts")).toBe(true);
  });

  it("returns false for non-test files", () => {
    expect(isTestFile("/repo/src/index.ts")).toBe(false);
    expect(isTestFile("/repo/lib/core.py")).toBe(false);
    expect(isTestFile("/repo/src/util.go")).toBe(false);
    expect(isTestFile("/repo/README.md")).toBe(false);
  });
});

// ─── symbolKey ──────────────────────────────────────────────────────────

describe("symbolKey", () => {
  it("generates filePath:line:col key", () => {
    expect(symbolKey({ filePath: "/repo/src/a.ts", line: 10, column: 4 })).toBe(
      "/repo/src/a.ts:10:4",
    );
  });
});

// ─── formatAmbiguity ────────────────────────────────────────────────────

describe("formatAmbiguity", () => {
  it("formats single ambiguous symbol", () => {
    const msg = formatAmbiguity([
      { name: "foo", kind: "function", filePath: "/a.ts", line: 1, column: 1 },
      { name: "foo", kind: "class", filePath: "/b.ts", line: 5, column: 3 },
    ]);
    expect(msg).toContain('"foo"');
    expect(msg).toContain("2 matches");
    expect(msg).toContain("/a.ts:1:1");
    expect(msg).toContain("/b.ts:5:3");
    expect(msg).toContain("(function)");
    expect(msg).toContain("(class)");
    expect(msg).toContain("{filePath, line, column}");
  });

  it("groups by name for multiple ambiguous symbols", () => {
    const msg = formatAmbiguity([
      { name: "foo", kind: "function", filePath: "/a.ts", line: 1, column: 1 },
      { name: "bar", kind: "function", filePath: "/b.ts", line: 5, column: 1 },
      { name: "bar", kind: "variable", filePath: "/c.ts", line: 10, column: 1 },
    ]);
    expect(msg).toContain('"foo"');
    expect(msg).toContain('"bar"');
    expect(msg).toContain("2 matches"); // for bar
    expect(msg).toContain("1 matches"); // for foo
  });

  it("shows containerName when present", () => {
    const msg = formatAmbiguity([
      {
        name: "foo",
        kind: "method",
        filePath: "/a.ts",
        line: 1,
        column: 1,
        containerName: "MyClass",
      },
    ]);
    expect(msg).toContain("[MyClass]");
  });

  it("truncates at 8 candidates per name", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      name: "overloaded",
      kind: "function" as const,
      filePath: `/f${i}.ts`,
      line: 1,
      column: 1,
    }));
    const msg = formatAmbiguity(candidates);
    expect(msg).toContain("10 matches");
    expect(msg).toContain("2 more");
  });
});

// ─── resolveSymbols ─────────────────────────────────────────────────────

describe("resolveSymbols", () => {
  it("resolves bare string names via workspace symbols", async () => {
    const rm = mockRuntimeManager({
      workspaceSymbols: async () => [
        {
          serverId: "vtsls",
          rootDir: "/repo",
          filePath: "/repo/src/index.ts",
          uri: "file:///repo/src/index.ts",
          result: [
            {
              name: "computeFoo",
              kind: SymbolKind.Function,
              location: loc("file:///repo/src/index.ts", 5, 0, 5, 20),
            } as SymbolInformation,
          ],
        },
      ],
    });

    const { resolved, ambiguous } = await resolveSymbols(["computeFoo"], rm);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("computeFoo");
    expect(resolved[0].kind).toBe("function");
    expect(resolved[0].filePath).toBe("/repo/src/index.ts");
    expect(resolved[0].line).toBe(6); // 1-based
    expect(resolved[0].column).toBe(1); // 1-based
    expect(ambiguous).toHaveLength(0);
  });

  it("resolves name with kind filter", async () => {
    const rm = mockRuntimeManager({
      workspaceSymbols: async () => [
        {
          serverId: "vtsls",
          rootDir: "/repo",
          filePath: "/repo/src/index.ts",
          uri: "file:///repo/src/index.ts",
          result: [
            {
              name: "Config",
              kind: SymbolKind.Class,
              location: loc("file:///repo/src/index.ts", 1, 0),
            } as SymbolInformation,
            {
              name: "Config",
              kind: SymbolKind.Interface,
              location: loc("file:///repo/src/other.ts", 1, 0),
            } as SymbolInformation,
          ],
        },
      ],
    });

    const { resolved, ambiguous } = await resolveSymbols(
      [{ name: "Config", kind: "interface" }],
      rm,
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0].kind).toBe("interface");
    expect(ambiguous).toHaveLength(0);
  });

  it("reports ambiguous names without filtering", async () => {
    const rm = mockRuntimeManager({
      workspaceSymbols: async () => [
        {
          serverId: "vtsls",
          rootDir: "/repo",
          filePath: "/repo/src/index.ts",
          uri: "file:///repo/src/index.ts",
          result: [
            {
              name: "parse",
              kind: SymbolKind.Function,
              location: loc("file:///repo/src/a.ts", 10, 0),
            } as SymbolInformation,
            {
              name: "parse",
              kind: SymbolKind.Function,
              location: loc("file:///repo/src/b.ts", 20, 0),
            } as SymbolInformation,
          ],
        },
      ],
    });

    const { resolved, ambiguous } = await resolveSymbols(["parse"], rm);

    expect(resolved).toHaveLength(0);
    expect(ambiguous).toHaveLength(2);
    expect(ambiguous[0].name).toBe("parse");
    expect(ambiguous[1].name).toBe("parse");
  });

  it("uses exact position when filePath+line+column provided", async () => {
    const rm = mockRuntimeManager({
      documentSymbols: async () => ({
        serverId: "vtsls",
        rootDir: "/repo",
        filePath: "/repo/src/index.ts",
        uri: "file:///repo/src/index.ts",
        result: [
          {
            name: "computeFoo",
            kind: SymbolKind.Function,
            range: { start: { line: 9, character: 0 }, end: { line: 20, character: 0 } },
            selectionRange: { start: { line: 9, character: 9 }, end: { line: 9, character: 19 } },
            children: [],
          } as DocumentSymbol,
        ],
      }),
    });

    const { resolved, ambiguous } = await resolveSymbols(
      [{ filePath: "/repo/src/index.ts", line: 10, column: 4 }],
      rm,
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("computeFoo"); // resolved from documentSymbols
    expect(resolved[0].kind).toBe("function");
    expect(resolved[0].filePath).toBe("/repo/src/index.ts");
    expect(ambiguous).toHaveLength(0);
  });

  it("exact position uses provided name when given", async () => {
    const rm = mockRuntimeManager({
      documentSymbols: async () => ({
        serverId: "vtsls",
        rootDir: "/repo",
        filePath: "/repo/src/index.ts",
        uri: "file:///repo/src/index.ts",
        result: [
          {
            name: "originalName",
            kind: SymbolKind.Function,
            range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
            selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
            children: [],
          } as DocumentSymbol,
        ],
      }),
    });

    const { resolved } = await resolveSymbols(
      [{ filePath: "/repo/src/index.ts", line: 5, column: 1, name: "explicitName" }],
      rm,
    );

    expect(resolved[0].name).toBe("explicitName"); // user-supplied name wins
  });

  it("returns empty resolved for unresolvable name", async () => {
    const rm = mockRuntimeManager({
      workspaceSymbols: async () => [],
    });

    const { resolved, ambiguous } = await resolveSymbols(["nonexistent"], rm);

    expect(resolved).toHaveLength(0);
    expect(ambiguous).toHaveLength(0);
  });

  it("gracefully handles documentSymbols failure by returning symbol kind", async () => {
    const rm = mockRuntimeManager({
      documentSymbols: async () => {
        throw new Error("server crashed");
      },
    });

    const { resolved } = await resolveSymbols(
      [{ filePath: "/repo/src/index.ts", line: 10, column: 4 }],
      rm,
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0].kind).toBe("symbol"); // fallback
    expect(resolved[0].name).toBe("<unknown>");
  });

  it("resolves exact positions inside nested DocumentSymbol children", async () => {
    const rm = mockRuntimeManager({
      documentSymbols: async () => ({
        serverId: "vtsls",
        rootDir: "/repo",
        filePath: "/repo/src/index.ts",
        uri: "file:///repo/src/index.ts",
        result: [
          {
            name: "MyClass",
            kind: SymbolKind.Class,
            range: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
            selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
            children: [
              {
                name: "myMethod",
                kind: SymbolKind.Method,
                range: { start: { line: 5, character: 2 }, end: { line: 15, character: 2 } },
                selectionRange: { start: { line: 5, character: 2 }, end: { line: 5, character: 12 } },
                children: [],
              },
            ],
          } as DocumentSymbol,
        ],
      }),
    });

    // Position inside myMethod
    const { resolved } = await resolveSymbols(
      [{ filePath: "/repo/src/index.ts", line: 10, column: 4 }],
      rm,
    );

    expect(resolved[0].name).toBe("myMethod"); // child wins over parent
    expect(resolved[0].kind).toBe("method");
  });

  it("fallback iterates servers when no active client returns workspace symbols", async () => {
    const tried = new Set<string>();
    const rm = mockRuntimeManager({
      workspaceSymbols: async (_query: string, serverId?: string) => {
        if (serverId) {
          tried.add(serverId);
          if (serverId === "vtsls") {
            return [{
              serverId: "vtsls",
              rootDir: "/repo",
              filePath: "/repo/src/index.ts",
              uri: "file:///repo/src/index.ts",
              result: [
                {
                  name: "fallbackFunc",
                  kind: SymbolKind.Function,
                  location: loc("file:///repo/src/index.ts", 10, 0),
                } as SymbolInformation,
              ],
            }];
          }
          return []; // other servers return empty
        }
        return []; // no active clients
      },
    });

    const { resolved, ambiguous } = await resolveSymbols(["fallbackFunc"], rm);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("fallbackFunc");
    expect(ambiguous).toHaveLength(0);
    // Should have tried at least vtsls (the first fallback)
    expect(tried.has("vtsls")).toBe(true);
  });

  it("fallback returns empty when no server returns results", async () => {
    const tried = new Set<string>();
    const rm = mockRuntimeManager({
      workspaceSymbols: async (_query: string, serverId?: string) => {
        if (serverId) tried.add(serverId);
        return []; // always empty
      },
    });

    const { resolved, ambiguous } = await resolveSymbols(["stillNonexistent"], rm);

    expect(resolved).toHaveLength(0);
    expect(ambiguous).toHaveLength(0);
    // Should have tried all fallback servers
    expect(tried.has("vtsls")).toBe(true);
    expect(tried.has("pyright")).toBe(true);
  });
});

// ─── analyzeImpact ──────────────────────────────────────────────────────

describe("analyzeImpact", () => {
  const sym: ResolvedSymbol = {
    name: "computeFoo",
    kind: "function",
    filePath: "/repo/src/index.ts",
    line: 10,
    column: 4,
  };

  it("returns report with changed symbols only at depth 0", async () => {
    const rm = mockRuntimeManager();
    const report = await analyzeImpact([sym], { depth: 0 }, rm);

    expect(report.changed).toHaveLength(1);
    expect(report.affectedFiles).toEqual(["/repo/src/index.ts"]);
    expect(report.totalLocations).toBe(0);
    expect(report.testFiles).toHaveLength(0);
  });

  it("queries references for callable symbols", async () => {
    const actualRefs: Location[] = [
      loc("file:///repo/src/other.ts", 0, 0),
    ];
    const rm = mockRuntimeManager({
      references: async () => ({
        serverId: "vtsls",
        rootDir: "/repo",
        filePath: "/repo/src/index.ts",
        uri: "file:///repo/src/index.ts",
        result: actualRefs,
      }),
    });

    const report = await analyzeImpact([sym], { depth: 1 }, rm);

    expect(report.totalLocations).toBe(1);
    expect(report.affectedFiles).toContain("/repo/src/other.ts");
  });

  it("queries call hierarchy for function/method/constructor kinds", async () => {
    const rm = mockRuntimeManager({
      references: async () => ({
        serverId: "vtsls",
        rootDir: "/repo",
        filePath: "/repo/src/index.ts",
        uri: "file:///repo/src/index.ts",
        result: [],
      }),
      callHierarchy: async () => ({
        serverId: "vtsls",
        rootDir: "/repo",
        filePath: "/repo/src/index.ts",
        uri: "file:///repo/src/index.ts",
        result: [
          {
            from: { uri: "file:///repo/src/caller.ts", name: "caller", kind: SymbolKind.Function },
            fromRanges: [{ start: { line: 5, character: 2 }, end: { line: 5, character: 12 } }],
          } as CallHierarchyIncomingCall,
        ],
      }),
    });

    const report = await analyzeImpact([sym], { depth: 1 }, rm);

    expect(report.callers.size).toBe(1);
    const callers = [...report.callers.values()][0];
    expect(callers).toHaveLength(1);
    expect(callers[0].filePath).toBe("/repo/src/caller.ts");
  });

  it("skips call hierarchy for non-callable kinds (variable, class, interface)", async () => {
    let callHierarchyCalled = false;
    const rm = mockRuntimeManager({
      references: async () => ({
        serverId: "vtsls",
        rootDir: "/repo",
        filePath: "/repo/src/index.ts",
        uri: "file:///repo/src/index.ts",
        result: [],
      }),
      callHierarchy: async () => {
        callHierarchyCalled = true;
        return {
          serverId: "vtsls",
          rootDir: "/repo",
          filePath: "/repo/src/index.ts",
          uri: "",
          result: [],
        };
      },
    });

    const classSym: ResolvedSymbol = {
      name: "MyConfig",
      kind: "class",
      filePath: "/repo/src/index.ts",
      line: 1,
      column: 1,
    };

    await analyzeImpact([classSym], { depth: 1 }, rm);
    expect(callHierarchyCalled).toBe(false);
  });

  it("does not count declaration position as a reference", async () => {
    const rm = mockRuntimeManager({
      references: async () => ({
        serverId: "vtsls",
        rootDir: "/repo",
        filePath: "/repo/src/index.ts",
        uri: "file:///repo/src/index.ts",
        result: [
          // Reference at the exact declaration position — should be filtered
          loc("file:///repo/src/index.ts", 9, 3), // 0-based: line 9, col 3 = 1-based: 10, 4
        ],
      }),
    });

    const report = await analyzeImpact([sym], { depth: 1 }, rm);
    expect(report.totalLocations).toBe(0); // filtered as same position as declaration
  });

  it("identifies test files in affected files", async () => {
    const rm = mockRuntimeManager({
      references: async () => ({
        serverId: "vtsls",
        rootDir: "/repo",
        filePath: "/repo/src/index.ts",
        uri: "file:///repo/src/index.ts",
        result: [
          loc("file:///repo/src/utils.test.ts", 0, 0),
          loc("file:///repo/src/lib.ts", 0, 0),
        ],
      }),
    });

    const report = await analyzeImpact([sym], { depth: 1 }, rm);

    expect(report.testFiles).toContain("/repo/src/utils.test.ts");
    expect(report.testFiles).not.toContain("/repo/src/lib.ts");
  });

  it("handles errors from LSP calls gracefully (non-fatal)", async () => {
    const rm = mockRuntimeManager({
      references: async () => {
        throw new Error("connection lost");
      },
      callHierarchy: async () => {
        throw new Error("connection lost");
      },
    });

    const report = await analyzeImpact([sym], { depth: 1 }, rm);

    expect(report.changed).toHaveLength(1);
    expect(report.refs.size).toBe(1);
    expect(report.refs.get(symbolKey(sym))).toEqual([]);
    expect(report.totalLocations).toBe(0);
  });
});

// ─── formatImpact ───────────────────────────────────────────────────────

describe("formatImpact", () => {
  it("includes header with symbol/ file/ location counts", () => {
    const text = formatImpact({
      changed: [
        {
          name: "computeFoo",
          kind: "function",
          filePath: "/repo/src/index.ts",
          line: 10,
          column: 4,
        },
      ],
      refs: new Map(),
      callers: new Map(),
      affectedFiles: ["/repo/src/index.ts"],
      testFiles: [],
      totalLocations: 0,
      fileCounts: new Map([
        ["/repo/src/index.ts", { changed: 1, refs: 0, isTest: false }],
      ]),
    });

    expect(text).toContain("Impact Analysis");
    expect(text).toContain("Changed symbols: 1");
    expect(text).toContain("Total affected files: 1");
    expect(text).toContain("Total affected locations: 0");
    expect(text).toContain("computeFoo");
  });

  it("includes test file count when present", () => {
    const text = formatImpact({
      changed: [
        {
          name: "computeFoo",
          kind: "function",
          filePath: "/repo/src/index.ts",
          line: 10,
          column: 4,
        },
      ],
      refs: new Map(),
      callers: new Map(),
      affectedFiles: ["/repo/src/index.ts", "/repo/src/utils.test.ts"],
      testFiles: ["/repo/src/utils.test.ts"],
      totalLocations: 0,
      fileCounts: new Map([
        ["/repo/src/index.ts", { changed: 1, refs: 0, isTest: false }],
        ["/repo/src/utils.test.ts", { changed: 0, refs: 0, isTest: true }],
      ]),
    });

    expect(text).toContain("(1 test files)");
    expect(text).toContain("utils.test.ts");
  });

  it("shows references per symbol", () => {
    const key = "/repo/src/index.ts:10:4";
    const text = formatImpact({
      changed: [
        {
          name: "computeFoo",
          kind: "function",
          filePath: "/repo/src/index.ts",
          line: 10,
          column: 4,
        },
      ],
      refs: new Map([
        [
          key,
          [
            { filePath: "/repo/src/lib.ts", line: 20, column: 1 },
            { filePath: "/repo/src/lib.ts", line: 30, column: 5 },
          ],
        ],
      ]),
      callers: new Map(),
      affectedFiles: ["/repo/src/index.ts", "/repo/src/lib.ts"],
      testFiles: [],
      totalLocations: 2,
      fileCounts: new Map([
        ["/repo/src/index.ts", { changed: 1, refs: 0, isTest: false }],
        ["/repo/src/lib.ts", { changed: 0, refs: 2, isTest: false }],
      ]),
    });

    expect(text).toContain("computeFoo");
    expect(text).toContain("2 refs");
    expect(text).toContain("lib.ts");
  });

  it("shows callers per symbol when present", () => {
    const key = "/repo/src/index.ts:10:4";
    const text = formatImpact({
      changed: [
        {
          name: "computeFoo",
          kind: "function",
          filePath: "/repo/src/index.ts",
          line: 10,
          column: 4,
        },
      ],
      refs: new Map(),
      callers: new Map([
        [
          key,
          [{ filePath: "/repo/src/caller.ts", line: 5, column: 2 }],
        ],
      ]),
      affectedFiles: ["/repo/src/index.ts", "/repo/src/caller.ts"],
      testFiles: [],
      totalLocations: 1,
      fileCounts: new Map([
        ["/repo/src/index.ts", { changed: 1, refs: 0, isTest: false }],
        ["/repo/src/caller.ts", { changed: 0, refs: 1, isTest: false }],
      ]),
    });

    expect(text).toContain("Callers: 1");
    expect(text).toContain("caller.ts");
  });
});
