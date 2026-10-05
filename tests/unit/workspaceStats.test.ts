import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import type { OutsideWorkspaceRefusal } from "../../src/lsp/runtimeManager.js";
import {
  flushWorkspaceScopeStats,
  getWorkspaceScopeStats,
  recordAutoWorkspaceRoot,
  recordOutsideWorkspaceRefusal,
  registerWorkspaceScopeStats,
  resetWorkspaceScopeStats,
} from "../../src/tools/workspaceStats.js";

interface AppendedEntry {
  customType: string;
  data: Record<string, unknown>;
}

/** The two ExtensionAPI methods the counters use; the rest of pi is irrelevant here. */
type MockPi = Pick<ExtensionAPI, "appendEntry" | "on">;

/**
 * The real function takes a whole ExtensionAPI, which a test cannot construct.
 * Casting once here keeps every call site honest about what is being faked.
 */
function registerWith(pi: MockPi): void {
  registerWorkspaceScopeStats(pi as unknown as ExtensionAPI);
}

function createMockPi(options: { appendEntryThrows?: boolean } = {}): {
  pi: MockPi;
  entries: AppendedEntry[];
  fire: (event: string) => void;
} {
  const entries: AppendedEntry[] = [];
  const handlers = new Map<string, Array<() => void>>();
  const pi: MockPi = {
    appendEntry: (customType: string, data?: unknown) => {
      if (options.appendEntryThrows) throw new Error("EACCES: session file is gone");
      entries.push({ customType, data: (data ?? {}) as Record<string, unknown> });
    },
    on: ((event: string, handler: () => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }) as MockPi["on"],
  };
  return {
    pi,
    entries,
    fire: (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
}

function refusal(
  filePath: string,
  suggestedRoot = "/tmp/sibling",
  reason: OutsideWorkspaceRefusal["reason"] = "tool",
): OutsideWorkspaceRefusal {
  return { filePath, workspaceRoots: ["/repo"], suggestedRoot, reason };
}

describe("workspace scope stats", () => {
  beforeEach(() => {
    resetWorkspaceScopeStats();
  });

  it("counts refusals per reason and per path", () => {
    const { pi } = createMockPi();
    registerWith(pi);

    recordOutsideWorkspaceRefusal(refusal("/tmp/sibling/src/a.ts"));
    recordOutsideWorkspaceRefusal(refusal("/tmp/sibling/src/a.ts"));
    recordOutsideWorkspaceRefusal(refusal("/tmp/other/b.py", "/tmp/other", "auto-diag-baseline"));
    recordOutsideWorkspaceRefusal(refusal("/tmp/read/x.ts", "/tmp/read", "warmup"));

    const stats = getWorkspaceScopeStats();
    expect(stats.toolRefusals).toBe(2);
    expect(stats.baselineRefusals).toBe(1);
    // Read warmup is not an LSP tool call, and counting it as one made
    // "from LSP tools" in /lsp status mostly report plain reads.
    expect(stats.warmupRefusals).toBe(1);
    expect(stats.distinctPaths).toBe(3);
    // The repeat is the signal that a refusal was ignored after the message
    // already named the fix.
    expect(stats.repeats).toBe(1);
    // lastSuggestedRoot follows the newest refusal, which here is the read.
    expect(stats.lastSuggestedRoot).toBe("/tmp/read");
  });

  it("flushes to the session file on cadence, carrying the worst offenders", () => {
    const { pi, entries } = createMockPi();
    registerWith(pi);

    for (let i = 0; i < 3; i += 1) recordOutsideWorkspaceRefusal(refusal("/tmp/a.ts"));
    expect(entries).toHaveLength(0);

    for (let i = 0; i < 2; i += 1) recordOutsideWorkspaceRefusal(refusal("/tmp/a.ts"));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.customType).toBe("lsp_workspace_scope");
    expect(entries[0]?.data).toMatchObject({
      cumulative: { toolRefusals: 5, distinctPaths: 1, repeats: 4 },
      sinceLastEntry: { toolRefusals: 5, distinctPaths: 1, repeats: 4 },
      lastSuggestedRoot: "/tmp/sibling",
      topPaths: [{ path: "/tmp/a.ts", hits: 5 }],
    });

    // Cumulative totals plus an explicit delta: a consumer summing entries
    // would otherwise multiply every refusal by the number of flushes.
    recordOutsideWorkspaceRefusal(refusal("/tmp/a.ts"));
    flushWorkspaceScopeStats();
    expect(entries).toHaveLength(2);
    expect(entries[1]?.data.sinceLastEntry).toMatchObject({ toolRefusals: 1, repeats: 1 });
    expect(entries[1]?.data.cumulative).toMatchObject({ toolRefusals: 6, repeats: 5 });
  });

  it("keeps the persisted snapshot readable as the path list grows", () => {
    const { pi, entries } = createMockPi();
    registerWith(pi);

    // Cadence flushes at 5 refusals, so the second snapshot carries only what
    // arrived after it. Distinct paths stay cumulative across snapshots.
    for (const i of [1, 2, 3, 4, 5]) recordOutsideWorkspaceRefusal(refusal(`/tmp/first-${i}.ts`));
    for (const i of [1, 2, 3, 4]) recordOutsideWorkspaceRefusal(refusal(`/tmp/second-${i}.ts`));
    flushWorkspaceScopeStats();

    expect(entries).toHaveLength(2);
    expect(entries[0]?.data.cumulative).toMatchObject({ distinctPaths: 5 });
    expect(entries[1]?.data.cumulative).toMatchObject({ distinctPaths: 9 });
    // The path map is cumulative, so the snapshot always carries the 5 worst
    // offenders of the session, not just of the last batch.
    expect((entries[1]?.data.topPaths as unknown[]).length).toBe(5);
    expect(entries[1]?.data.sinceLastEntry).toMatchObject({ distinctPaths: 4 });
  });

  it("flushes at session shutdown and zeros at session start", () => {
    const { pi, entries, fire } = createMockPi();
    registerWith(pi);

    recordOutsideWorkspaceRefusal(refusal("/tmp/a.ts"));
    expect(entries).toHaveLength(0);

    fire("session_shutdown");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data.cumulative).toMatchObject({ toolRefusals: 1 });

    // Counters live in module state, so a /new or /resume must not inherit them.
    fire("session_start");
    expect(getWorkspaceScopeStats()).toMatchObject({ toolRefusals: 0, distinctPaths: 0, repeats: 0 });
  });

  it("keeps the batch and stays quiet when appendEntry throws", () => {
    // appendEntry is synchronous file I/O; a counter that throws through the
    // refusal path would break the edit that triggered the refusal.
    const { pi, entries } = createMockPi({ appendEntryThrows: true });
    registerWith(pi);

    expect(() => {
      for (let i = 0; i < 5; i += 1) recordOutsideWorkspaceRefusal(refusal("/tmp/a.ts"));
    }).not.toThrow();
    expect(entries).toHaveLength(0);
    // Cumulative totals survive the failed write, so the flush is retried.
    expect(getWorkspaceScopeStats().toolRefusals).toBe(5);
  });

  it("records automatically added roots so the widening stays visible", () => {
    const { pi, entries } = createMockPi();
    registerWith(pi);

    recordAutoWorkspaceRoot("/checkout/task");
    recordAutoWorkspaceRoot("/checkout/task");
    recordAutoWorkspaceRoot("/checkout/other");
    flushWorkspaceScopeStats();

    const cumulative = entries[0]?.data.cumulative as { autoAdded: number; autoAddedRoots: string[] } | undefined;
    expect(cumulative).toMatchObject({ autoAdded: 3 });
    // Distinct roots, so a hot loop on one project cannot bloat the entry.
    expect(cumulative?.autoAddedRoots).toEqual(["/checkout/task", "/checkout/other"]);
    // An auto-add is not a refusal: it must not inflate the refusal totals.
    expect(getWorkspaceScopeStats().toolRefusals).toBe(0);
  });

  it("flushes an automatic widening on its own cadence", () => {
    // A session that only ever auto-adds never refuses anything, so a cadence
    // that counts only refusals leaves no record at all unless the session
    // shuts down cleanly - which is exactly the case this log exists for.
    const { pi, entries } = createMockPi();
    registerWith(pi);

    for (let i = 0; i < 4; i++) recordAutoWorkspaceRoot(`/checkout-${i}`);
    expect(entries).toHaveLength(0);

    recordAutoWorkspaceRoot("/checkout-final");
    flushWorkspaceScopeStats();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.data.cumulative).toMatchObject({ autoAdded: 5 });
    expect(entries[0]?.data.sinceLastEntry).toMatchObject({ autoAdded: 5 });
  });

  it("does not write when nothing was recorded", () => {
    const { pi, entries, fire } = createMockPi();
    registerWith(pi);

    fire("session_shutdown");
    flushWorkspaceScopeStats();

    expect(entries).toHaveLength(0);
  });
});
