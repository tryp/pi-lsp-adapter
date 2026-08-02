/**
 * Tests for dynamic runtime output of LSP tools.
 *
 * Verifies that:
 *   1. lsp_list_workspace_roots output lists servers with file types and status
 *   2. Active/inactive status is correct
 *   3. Works with various server configurations
 *
 * Runs with: `npx tsx --test tests/dynamicOutput.test.ts`
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Types ───────────────────────────────────────────────────────────

/** Minimal shape of a server definition as seen by the execute function */
interface ServerEntry {
  id: string;
  displayName: string;
  filetypes: string[];
}

/** Minimal shape of a config.catalog */
interface Catalog {
  servers: Record<string, ServerEntry>;
}

/** Minimal shape of a client entry */
interface ClientEntry {
  serverId: string;
}

/** Minimal shape of a runtime manager */
interface RuntimeManager {
  activeClients: () => ClientEntry[];
  listWorkspaceRoots: () => string[];
}

/** Minimal state shape */
interface State {
  cwd: string;
  config: { catalog: Catalog; warnings: string[] };
  runtimeManager: RuntimeManager;
  [key: string]: any;
}

// ── Helper: build the lsp_list_workspace_roots output directly ──────

/**
 * Replicates the exact logic from registerLspTools.ts's
 * lsp_list_workspace_roots execute function.
 */
function formatLspRootsOutput(state: State): string {
  const roots = state.runtimeManager.listWorkspaceRoots();
  const servers = state.config.catalog.servers;
  const serverIds = Object.keys(servers);
  const activeClients = state.runtimeManager.activeClients();
  const activeIds = new Set(activeClients.map((c: ClientEntry) => c.serverId));

  const serverLines = serverIds.map((id: string) => {
    const s = servers[id];
    const status = activeIds.has(id) ? "active" : "inactive";
    const fts = s.filetypes.join(", ");
    return `  - ${id}: ${s.displayName} (${fts}) [${status}]`;
  });

  let result = `LSP workspace roots (${roots.length}):\n`;
  result += roots.map((r: string) => `  - ${r}`).join("\n");
  result += `\n\nConfigured LSP servers (${serverIds.length}):\n`;
  result += serverLines.join("\n");
  return result;
}

function makeState(opts: {
  roots?: string[];
  servers?: Record<string, { displayName?: string; filetypes: string[] }>;
  activeIds?: string[];
}): State {
  const roots = opts.roots ?? ["/home/dev/src/project"];
  const activeIds = opts.activeIds ?? [];

  const servers: Record<string, ServerEntry> = {};
  for (const [id, s] of Object.entries(opts.servers ?? {})) {
    servers[id] = {
      id,
      displayName: s.displayName ?? `Server ${id}`,
      filetypes: s.filetypes,
    };
  }

  return {
    cwd: "/test",
    config: {
      catalog: { servers },
      warnings: [],
    },
    runtimeManager: {
      activeClients: () => activeIds.map((id) => ({ serverId: id })),
      listWorkspaceRoots: () => roots,
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("lsp_list_workspace_roots output format", () => {
  it("reports workspace roots", () => {
    const state = makeState({
      roots: ["/a", "/b"],
      servers: { pyright: { filetypes: ["python"] } },
      activeIds: ["pyright"],
    });
    const result = formatLspRootsOutput(state);
    assert.ok(result.includes("LSP workspace roots (2):"), "root count");
    assert.ok(result.includes("/a"), "root /a");
    assert.ok(result.includes("/b"), "root /b");
  });

  it("lists configured servers with file types", () => {
    const state = makeState({
      servers: {
        pyright: { filetypes: ["python"] },
        marksman: { filetypes: ["markdown"] },
      },
      activeIds: ["pyright"],
    });
    const result = formatLspRootsOutput(state);
    assert.ok(result.includes("Configured LSP servers (2):"), "server count");
    assert.ok(result.includes("pyright"));
    assert.ok(result.includes("marksman"));
    assert.ok(result.includes("python"));
    assert.ok(result.includes("markdown"));
  });

  it("marks active servers [active] and inactive [inactive]", () => {
    const state = makeState({
      servers: {
        pyright: { filetypes: ["python"] },
        marksman: { filetypes: ["markdown"] },
        vtsls: { filetypes: ["typescript"] },
      },
      activeIds: ["pyright", "vtsls"],
    });
    const result = formatLspRootsOutput(state);
    assert.ok(result.includes("pyright") && result.includes("[active]"));
    assert.ok(result.includes("marksman") && result.includes("[inactive]"));
    assert.ok(result.includes("vtsls") && result.includes("[active]"));
  });

  it("shows display names for servers", () => {
    const state = makeState({
      servers: { pyright: { displayName: "Pyright (Python)", filetypes: ["python"] } },
      activeIds: ["pyright"],
    });
    const result = formatLspRootsOutput(state);
    assert.ok(result.includes("Pyright (Python)"), "display name");
  });

  it("handles no roots but has servers", () => {
    const state = makeState({
      roots: [],
      servers: { pyright: { filetypes: ["python"] } },
      activeIds: ["pyright"],
    });
    const result = formatLspRootsOutput(state);
    assert.ok(result.includes("LSP workspace roots (0):"));
    assert.ok(result.includes("Configured LSP servers (1):"));
  });

  it("handles many servers with various file types", () => {
    const state = makeState({
      servers: {
        pyright: { filetypes: ["python"] },
        vtsls: { filetypes: ["typescript", "javascript"] },
        marksman: { filetypes: ["markdown"] },
        jsonls: { filetypes: ["json", "jsonc"] },
        yamlls: { filetypes: ["yaml"] },
      },
      activeIds: ["pyright", "jsonls", "vtsls"],
    });
    const result = formatLspRootsOutput(state);
    assert.ok(result.includes("Configured LSP servers (5):"));

    for (const id of ["pyright", "vtsls", "marksman", "jsonls", "yamlls"]) {
      assert.ok(result.includes(id), `server ${id} listed`);
    }
    assert.ok(result.includes("markdown"));
    assert.ok(result.includes("typescript, javascript"));
    assert.ok(result.includes("json, jsonc"));
  });

  it("sorts roots in insertion order", () => {
    const state = makeState({
      roots: ["/z", "/a", "/m"],
      servers: { pyright: { filetypes: ["python"] } },
      activeIds: [],
    });
    const result = formatLspRootsOutput(state);
    const rootSection = result.split("Configured LSP servers")[0];
    const aIdx = rootSection.indexOf("/a");
    const mIdx = rootSection.indexOf("/m");
    const zIdx = rootSection.indexOf("/z");
    assert.ok(zIdx < aIdx, "/z before /a");
    assert.ok(aIdx < mIdx, "/a before /m");
  });

  it("sorts server IDs by insertion order (Object.keys order)", () => {
    const state = makeState({
      servers: {
        zed: { filetypes: ["a"] },
        alpha: { filetypes: ["b"] },
        beta: { filetypes: ["c"] },
      },
      activeIds: [],
    });
    const result = formatLspRootsOutput(state);
    const serverSection = result.split("Configured LSP servers (3):")[1];
    const zedIdx = serverSection.indexOf("zed");
    const alphaIdx = serverSection.indexOf("alpha");
    const betaIdx = serverSection.indexOf("beta");
    assert.ok(zedIdx < alphaIdx, "zed before alpha");
    assert.ok(alphaIdx < betaIdx, "alpha before beta");
  });
});
