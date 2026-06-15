/**
 * Tests for src/statusLine.ts — LSP status line formatting.
 *
 * Runs with: `npx tsx --test tests/statusLine.test.ts`
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatLspStatusLine } from "../src/statusLine.js";

// ── Shared mock data ────────────────────────────────────────────────

/** Minimal state shape needed by formatLspStatusLine */
interface MockClient {
  serverId: string;
}

interface MockRuntimeManager {
  activeClients: () => MockClient[];
}

interface MockCatalog {
  servers: Record<string, any>;
}

interface MockConfig {
  catalog: MockCatalog;
  warnings: string[];
}

interface MockState {
  runtimeManager: MockRuntimeManager;
  config: MockConfig;
}

function mockState(opts: {
  activeIds?: string[];
  serverIds?: string[];
  warnings?: string[];
}): MockState {
  const activeIds = opts.activeIds ?? [];
  const serverIds = opts.serverIds ?? [];
  const warnings = opts.warnings ?? [];

  const servers: Record<string, any> = {};
  for (const id of serverIds) {
    servers[id] = { id, displayName: id, filetypes: [] };
  }

  return {
    runtimeManager: {
      activeClients: () => activeIds.map((id) => ({ serverId: id })),
    },
    config: {
      catalog: { servers },
      warnings,
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("formatLspStatusLine", () => {
  it("reports no servers when catalog is empty", () => {
    const s = mockState({});
    assert.equal(formatLspStatusLine(s as any), "LSP: 0/0 servers: (none active)");
  });

  it("reports no active servers when none started", () => {
    const s = mockState({
      serverIds: ["pyright", "marksman", "vtsls"],
      activeIds: [],
    });
    assert.equal(
      formatLspStatusLine(s as any),
      "LSP: 0/3 servers: (none active)",
    );
  });

  it("reports all servers active when all started", () => {
    const s = mockState({
      serverIds: ["pyright", "marksman"],
      activeIds: ["marksman", "pyright"],
    });
    assert.equal(
      formatLspStatusLine(s as any),
      "LSP: 2/2 servers: marksman, pyright",
    );
  });

  it("lists active server IDs", () => {
    const s = mockState({
      serverIds: ["pyright", "marksman", "vtsls", "jsonls"],
      activeIds: ["pyright", "vtsls"],
    });
    assert.equal(
      formatLspStatusLine(s as any),
      "LSP: 2/4 servers: pyright, vtsls",
    );
  });

  it("sorts active server IDs alphabetically", () => {
    const s = mockState({
      serverIds: ["a", "b", "c"],
      activeIds: ["c", "a", "b"],
    });
    assert.equal(
      formatLspStatusLine(s as any),
      "LSP: 3/3 servers: a, b, c",
    );
  });

  it("appends warning count when warnings present", () => {
    const s = mockState({
      serverIds: ["pyright"],
      activeIds: ["pyright"],
      warnings: ["deprecated server config"],
    });
    assert.equal(
      formatLspStatusLine(s as any),
      "LSP: 1/1 servers: pyright, 1 warning(s)",
    );
  });

  it("handles multiple warnings", () => {
    const s = mockState({
      serverIds: ["a", "b"],
      activeIds: ["a"],
      warnings: ["warning 1", "warning 2"],
    });
    assert.equal(
      formatLspStatusLine(s as any),
      "LSP: 1/2 servers: a, 2 warning(s)",
    );
  });

  it("deduplicates duplicate active client entries", () => {
    const s = mockState({
      serverIds: ["vtsls"],
      activeIds: ["vtsls", "vtsls"], // two clients for same server
    });
    assert.equal(
      formatLspStatusLine(s as any),
      "LSP: 1/1 servers: vtsls",
    );
  });

  it("handles single server active", () => {
    const s = mockState({
      serverIds: ["marksman"],
      activeIds: ["marksman"],
    });
    assert.equal(
      formatLspStatusLine(s as any),
      "LSP: 1/1 servers: marksman",
    );
  });

  it("handles many servers, some active", () => {
    const s = mockState({
      serverIds: [
        "gopls", "jdtls", "jsonls", "marksman", "pyright",
        "ruff", "ruff-lsp", "rust-analyzer", "vtsls", "yamlls",
      ],
      activeIds: ["pyright", "vtsls", "jsonls"],
    });
    assert.equal(
      formatLspStatusLine(s as any),
      "LSP: 3/10 servers: jsonls, pyright, vtsls",
    );
  });
});
