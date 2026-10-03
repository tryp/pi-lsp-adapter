import { describe, expect, it, vi } from "vitest";
import { registerLspTools } from "../../src/tools/registerLspTools.js";
import type { LspExtensionState } from "../../src/state.js";

/**
 * Regression tests for the auto-diag pre/post diagnostic diff.
 *
 * Background: the diff compares pre-edit diagnostics (captured in `tool_call`)
 * against post-edit diagnostics (read in `tool_result`) and steers the agent
 * when new errors appear. Two ways this went wrong in real sessions:
 *
 *  1. An absent baseline was treated as an empty one (`before ?? []`), so a
 *     file's entire pre-existing error set was reported as newly introduced.
 *  2. Diagnostics were read after a fixed delay, so an already-fixed error
 *     could be reported as new.
 */

type Handler = (event: never, ctx?: never) => unknown;

interface Harness {
  handlers: Map<string, Handler>;
  sendMessage: ReturnType<typeof vi.fn>;
  getFlag: () => boolean;
}

function setup(
  state: LspExtensionState | null,
  { autoDiag = true }: { autoDiag?: boolean } = {},
): Harness {
  const handlers = new Map<string, Handler>();
  const sendMessage = vi.fn();
  const api = {
    registerTool: () => {},
    registerToolPromptGuidelines: () => {},
    registerFlag: () => {},
    registerCommands: () => {},
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    getFlag: () => autoDiag,
    sendMessage,
  };
  registerLspTools(api as never, () => state);
  return { handlers, sendMessage, getFlag: () => autoDiag };
}

function fakeState(options: {
  cachedDiagnostics?: () => unknown;
  diagnostics?: () => Promise<unknown>;
  diagnosticsWithFixes?: () => Promise<unknown>;
}): LspExtensionState {
  return {
    ownerId: "test",
    cwd: "/repo",
    config: {
      catalog: { servers: {} },
      warnings: [],
      installMode: "auto",
      warmup: false,
      extraWorkspaceRoots: [],
    },
    installManager: {} as never,
    processRegistry: {} as never,
    resultCache: { clear: () => {}, get: () => undefined, set: () => undefined } as never,
    runtimeManager: {
      cachedDiagnostics: options.cachedDiagnostics ?? (() => undefined),
      diagnosticsWithFixes:
        options.diagnosticsWithFixes ??
        (async () => ({
          diagnostics: { diagnostics: [] },
          codeActions: null,
          diagnosticActions: [],
        })),
      diagnostics:
        options.diagnostics ?? (async () => ({ diagnostics: [], published: true })),
    } as never,
  };
}

const editCall = (id: string, path: string) =>
  ({ toolName: "edit", toolCallId: id, input: { path } }) as never;

const editResult = (id: string, path: string) =>
  ({ toolName: "edit", toolCallId: id, input: { path }, isError: false }) as never;

function diag(line: number, message: string, severity = 1) {
  return { severity, message, code: "reportX", range: { start: { line, character: 0 }, end: { line, character: 1 } } };
}

function autoDiagBody(sendMessage: ReturnType<typeof vi.fn>): string | undefined {
  const call = sendMessage.mock.calls[0];
  if (!call) return undefined;
  return (call[0] as { content: string }).content;
}

describe("auto-diag baseline handling", () => {
  it("ignores diagnostics when the server published nothing before the wait expired", async () => {
    // A slow server yields `diagnostics: []` with published=false. Treating
    // that as a clean baseline would blame every pre-existing error on this
    // edit - the original defect.
    const state = fakeState({
      cachedDiagnostics: () => undefined,
      diagnostics: async () => ({ diagnostics: [], published: false }),
      diagnosticsWithFixes: async () => ({
        diagnostics: { diagnostics: [diag(3, "pre-existing error")] },
        codeActions: null,
        diagnosticActions: [],
      }),
    });
    const { handlers, sendMessage } = setup(state);

    await handlers.get("tool_call")!(editCall("slow", "/repo/slow.py"));
    await handlers.get("tool_result")!(editResult("slow", "/repo/slow.py"));

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("steers when the server published an empty set and the edit adds an error", async () => {
    // published=true with [] is a genuine "file was clean" baseline, and a
    // new error must still be reported.
    const state = fakeState({
      cachedDiagnostics: () => undefined,
      diagnostics: async () => ({ diagnostics: [], published: true }),
      diagnosticsWithFixes: async () => ({
        diagnostics: { diagnostics: [diag(5, "introduced")] },
        codeActions: null,
        diagnosticActions: [],
      }),
    });
    const { handlers, sendMessage } = setup(state);

    await handlers.get("tool_call")!(editCall("clean", "/repo/clean.py"));
    await handlers.get("tool_result")!(editResult("clean", "/repo/clean.py"));

    expect(autoDiagBody(sendMessage)).toContain("1 new error");
    expect(autoDiagBody(sendMessage)).toContain("introduced");
  });

  it("does not steer when starting a baseline client fails", async () => {
    // No live client for this file -> cachedDiagnostics returns undefined.
    // Before the fix, `before ?? []` made the diff treat the file as clean
    // and report every existing error as newly introduced.
    const state = fakeState({
      cachedDiagnostics: () => undefined,
      diagnostics: async () => { throw new Error("no server"); },
      diagnosticsWithFixes: async () => ({
        diagnostics: { diagnostics: [diag(3, "pre-existing error")] },
        codeActions: null,
        diagnosticActions: [],
      }),
    });
    const { handlers, sendMessage } = setup(state);

    await handlers.get("tool_call")!(editCall("c1", "/repo/a.py"));
    await handlers.get("tool_result")!(editResult("c1", "/repo/a.py"));

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("uses awaited diagnostics as the first-edit baseline and steers on a new error", async () => {
    const diagnostics = vi.fn(async () => ({
      diagnostics: [diag(2, "existing")],
      published: true,
    }));
    const state = fakeState({
      cachedDiagnostics: () => undefined,
      diagnostics,
      diagnosticsWithFixes: async () => ({
        diagnostics: { diagnostics: [diag(2, "existing"), diag(8, "introduced")] },
        codeActions: null,
        diagnosticActions: [],
      }),
    });
    const { handlers, sendMessage } = setup(state);

    await handlers.get("tool_call")!(editCall("first", "/repo/first.py"));
    expect(diagnostics).toHaveBeenCalledWith("/repo/first.py");
    await handlers.get("tool_result")!(editResult("first", "/repo/first.py"));

    expect(autoDiagBody(sendMessage)).toContain("introduced");
    expect(autoDiagBody(sendMessage)).not.toContain("existing");
  });

  it("steers when an explicit empty baseline gains a new error", async () => {
    // An explicit `[]` is a valid "file was clean" baseline.
    const state = fakeState({
      cachedDiagnostics: () => [],
      diagnosticsWithFixes: async () => ({
        diagnostics: { diagnostics: [diag(7, "brand new error")] },
        codeActions: null,
        diagnosticActions: [],
      }),
    });
    const { handlers, sendMessage } = setup(state);

    await handlers.get("tool_call")!(editCall("c2", "/repo/b.py"));
    await handlers.get("tool_result")!(editResult("c2", "/repo/b.py"));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(autoDiagBody(sendMessage)).toContain("1 new error");
  });

  it("does not steer when a known error is unchanged", async () => {
    const existing = diag(3, "already there");
    const state = fakeState({
      cachedDiagnostics: () => [existing],
      diagnosticsWithFixes: async () => ({
        diagnostics: { diagnostics: [{ ...existing }] },
        codeActions: null,
        diagnosticActions: [],
      }),
    });
    const { handlers, sendMessage } = setup(state);

    await handlers.get("tool_call")!(editCall("c3", "/repo/c.py"));
    await handlers.get("tool_result")!(editResult("c3", "/repo/c.py"));

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("reports only the genuinely new error out of a mixed set", async () => {
    const known = diag(3, "already there");
    const fresh = diag(9, "introduced now");
    const state = fakeState({
      cachedDiagnostics: () => [known],
      diagnosticsWithFixes: async () => ({
        diagnostics: { diagnostics: [{ ...known }, fresh] },
        codeActions: null,
        diagnosticActions: [],
      }),
    });
    const { handlers, sendMessage } = setup(state);

    await handlers.get("tool_call")!(editCall("c4", "/repo/d.py"));
    await handlers.get("tool_result")!(editResult("c4", "/repo/d.py"));

    const body = autoDiagBody(sendMessage);
    expect(body).toContain("1 new error");
    expect(body).toContain("introduced now");
    expect(body).not.toContain("already there");
  });

  it("stays silent when auto-diag is disabled", async () => {
    const diagnostics = vi.fn(async () => ({ diagnostics: [], published: true }));
    const state = fakeState({
      cachedDiagnostics: () => undefined,
      diagnostics,
      diagnosticsWithFixes: async () => ({
        diagnostics: { diagnostics: [diag(1, "err")] },
        codeActions: null,
        diagnosticActions: [],
      }),
    });
    const { handlers, sendMessage } = setup(state, { autoDiag: false });

    await handlers.get("tool_call")!(editCall("c5", "/repo/e.py"));
    await handlers.get("tool_result")!(editResult("c5", "/repo/e.py"));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it("uses the baseline captured at tool_call, not a later cache state", async () => {
    // The pre-edit baseline must be snapshotted synchronously at tool_call.
    // If the handler deferred the read, it could observe post-edit state.
    let cache: ReturnType<typeof diag>[] = [diag(1, "pre-edit state")];
    const state = fakeState({
      cachedDiagnostics: () => cache,
      diagnosticsWithFixes: async () => ({
        diagnostics: { diagnostics: [diag(1, "pre-edit state"), diag(9, "introduced")] },
        codeActions: null,
        diagnosticActions: [],
      }),
    });
    const { handlers, sendMessage } = setup(state);

    await handlers.get("tool_call")!(editCall("c6", "/repo/f.py"));

    // The cache changes after the baseline was taken (as it would once the
    // edit lands and the server republishes).
    cache = [diag(1, "pre-edit state"), diag(9, "introduced")];

    await handlers.get("tool_result")!(editResult("c6", "/repo/f.py"));

    // Only "introduced" is new relative to the captured baseline.
    const body = autoDiagBody(sendMessage);
    expect(body).toContain("1 new error");
    expect(body).toContain("introduced");
    expect(body).not.toContain("pre-edit state");
  });

  it("does not retain a failed edit's baseline for a later result", async () => {
    // Failed edits are common. If their entry survives, a later result for the
    // same tool call would diff against an outdated snapshot and mis-report.
    // Here the kept baseline says "clean", while the file actually has a
    // pre-existing error that must NOT be blamed on this edit.
    const state = fakeState({
      cachedDiagnostics: () => [],
      diagnosticsWithFixes: async () => ({
        diagnostics: { diagnostics: [diag(4, "pre-existing, not from this edit")] },
        codeActions: null,
        diagnosticActions: [],
      }),
    });
    const { handlers, sendMessage } = setup(state);

    await handlers.get("tool_call")!(editCall("c7", "/repo/g.py"));

    await handlers.get("tool_result")!({
      toolName: "edit", toolCallId: "c7", input: { path: "/repo/g.py" }, isError: true,
    } as never);
    expect(sendMessage).not.toHaveBeenCalled();

    // The baseline must be gone, so this result has no baseline and stays
    // silent instead of reporting the pre-existing error as new.
    await handlers.get("tool_result")!({
      toolName: "edit", toolCallId: "c7", input: { path: "/repo/g.py" }, isError: false,
    } as never);

    expect(sendMessage).not.toHaveBeenCalled();
  });
  it("works for the write tool, not only edit", async () => {
    const state = fakeState({
      cachedDiagnostics: () => [],
      diagnosticsWithFixes: async () => ({
        diagnostics: { diagnostics: [diag(2, "new from write")] },
        codeActions: null,
        diagnosticActions: [],
      }),
    });
    const { handlers, sendMessage } = setup(state);

    await handlers.get("tool_call")!({
      toolName: "write", toolCallId: "w1", input: { path: "/repo/new.py" },
    } as never);
    await handlers.get("tool_result")!({
      toolName: "write", toolCallId: "w1", input: { path: "/repo/new.py" }, isError: false,
    } as never);

    expect(autoDiagBody(sendMessage)).toContain("1 new error");
  });

  it("does not throw when a tool result carries no input", async () => {
    const state = fakeState({ cachedDiagnostics: () => [] });
    const { handlers, sendMessage } = setup(state);

    await expect(
      handlers.get("tool_result")!({
        toolName: "edit", toolCallId: "n1", isError: false,
      } as never) as Promise<unknown>,
    ).resolves.toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps concurrent edits to one file isolated by tool call id", async () => {
    // Two edits in flight on the same path must each diff against their OWN
    // baseline; sharing one would attribute errors to the wrong edit.
    let cache = [diag(1, "before both")];
    const state = fakeState({
      cachedDiagnostics: () => [...cache],
      diagnosticsWithFixes: async () => ({
        diagnostics: { diagnostics: [diag(1, "before both"), diag(9, "added")] },
        codeActions: null,
        diagnosticActions: [],
      }),
    });
    const { handlers, sendMessage } = setup(state);

    await handlers.get("tool_call")!(editCall("a1", "/repo/x.py"));
    cache = [];
    await handlers.get("tool_call")!(editCall("a2", "/repo/x.py"));

    await handlers.get("tool_result")!(editResult("a1", "/repo/x.py"));
    const first = autoDiagBody(sendMessage);
    expect(first).toContain("1 new error");
    expect(first).not.toContain("before both");

    sendMessage.mockClear();
    await handlers.get("tool_result")!(editResult("a2", "/repo/x.py"));
    // a2 captured an empty baseline, so both errors are new for that call.
    expect(autoDiagBody(sendMessage)).toContain("2 new error");
  });
});
