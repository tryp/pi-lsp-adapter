import { describe, expect, it } from "vitest";
import { formatLspStatus, type LspStatusSnapshot } from "../../src/commands/status.js";

function snapshot(overrides: Partial<LspStatusSnapshot> = {}): LspStatusSnapshot {
  return {
    config: {
      installMode: "auto",
      warmup: true,
      catalog: {
        servers: {
          vtsls: { id: "vtsls", command: "vtsls", extensions: [".ts"] },
          pyright: {
            id: "pyright",
            command: "pyright-langserver",
            extensions: [".py"],
            diagnosticsWaitMs: 8000,
          },
        },
      },
      warnings: [],
      autoWorkspaceRoots: [],
      autoWorkspaceRootMode: "trusted",
    } as unknown as LspStatusSnapshot["config"],
    lockfile: { servers: { vtsls: { version: "0.9.0" } } } as unknown as LspStatusSnapshot["lockfile"],
    processes: [{ serverId: "vtsls", pid: 1 }] as LspStatusSnapshot["processes"],
    ...overrides,
  };
}

describe("formatLspStatus auto-diag block", () => {
  it("reports the effective wait bound per server, marking the default", () => {
    const text = formatLspStatus(snapshot());

    // A server on the built-in default is the common case; the whole point of
    // the block is that a coverage collapse is diagnosable from `/lsp status`.
    expect(text).toContain("- vtsls: installed, 1 process, diagnosticsWaitMs 5000 (default)");
    expect(text).toContain("- pyright: missing, 0 processes, diagnosticsWaitMs 8000");
  });

  it("lists every outcome counter with a share for the wait expiries", () => {
    const text = formatLspStatus(
      snapshot({
        autoDiagStats: {
          edits: 100,
          emitted: 40,
          no_baseline: 10,
          no_client: 5,
          not_published: 30,
          no_new_errors: 15,
          edit_failed: 2,
          baseline_failed: 3,
          post_edit_failed: 1,
          unflushed: 7,
        },
      }),
    );

    expect(text).toContain("auto-diag outcomes:");
    expect(text).toContain("- edits handled: 100");
    expect(text).toContain("- steers emitted: 40");
    expect(text).toContain("- not published in time: 30 (30.0% of edits)");
    expect(text).toContain("- no baseline: 10");
    expect(text).toContain("- no client for file: 5");
    expect(text).toContain("- failed edits: 2");
  });

  it("omits the outcome block when no edit has been handled", () => {
    const text = formatLspStatus(snapshot());

    expect(text).not.toContain("auto-diag outcomes:");
  });
});