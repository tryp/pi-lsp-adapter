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
      diagnostics: options.diagnostics ?? (async () => ({ diagnostics: [] })),
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
  it("does not steer when no pre-edit baseline was captured", async () => {
    // No live client for this file -> cachedDiagnostics returns undefined.
    // Before the fix, `before ?? []` made the diff treat the file as clean
    // and report every existing error as newly introduced.
    const state = fakeState({
      cachedDiagnostics: () => undefined,
      diagnosticsWithFixes: async () => ({
        diagnostics: { diagnostics: [diag(3, "pre-existing error")] },
        codeActions: null,
        diagnosticActions: [],
      }),
    });
    const { handlers, sendMessage } = setup(state);

    handlers.get("tool_call")!(editCall("c1", "/repo/a.py"));
    await handlers.get("tool_result")!(editResult("c1", "/repo/a.py"));

    expect(sendMessage).not.toHaveBeenCalled();
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

    handlers.get("tool_call")!(editCall("c2", "/repo/b.py"));
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

    handlers.get("tool_call")!(editCall("c3", "/repo/c.py"));
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

    handlers.get("tool_call")!(editCall("c4", "/repo/d.py"));
    await handlers.get("tool_result")!(editResult("c4", "/repo/d.py"));

    const body = autoDiagBody(sendMessage);
    expect(body).toContain("1 new error");
    expect(body).toContain("introduced now");
    expect(body).not.toContain("already there");
  });

  it("stays silent when auto-diag is disabled", async () => {
    const state = fakeState({
      cachedDiagnostics: () => [],
      diagnosticsWithFixes: async () => ({
        diagnostics: { diagnostics: [diag(1, "err")] },
        codeActions: null,
        diagnosticActions: [],
      }),
    });
    const { handlers, sendMessage } = setup(state, { autoDiag: false });

    handlers.get("tool_call")!(editCall("c5", "/repo/e.py"));
    await handlers.get("tool_result")!(editResult("c5", "/repo/e.py"));

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("takes the baseline synchronously from the cache, never awaiting a read", () => {
    // The pre-edit snapshot must not be a fire-and-forget async read: that was
    // what let it capture post-edit state.
    const cachedDiagnostics = vi.fn(() => [diag(1, "snapshot")]);
    const state = fakeState({ cachedDiagnostics });
    const { handlers } = setup(state);

    handlers.get("tool_call")!(editCall("c6", "/repo/f.py"));

    expect(cachedDiagnostics).toHaveBeenCalledTimes(1);
  });
});
