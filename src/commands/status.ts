import type { LoadLspConfigResult } from "../config/loadConfig.js";
import type { LspLockfile } from "../install/lockfile.js";
import type { LspProcessEntry } from "../lsp/processRegistry.js";
import { DEFAULT_DIAGNOSTICS_WAIT_MS } from "../lsp/runtimeManager.js";
import type { ServerDefinition } from "../registry/schema.js";
// Type-only: erased at runtime, so no import cycle with the tool registration.
import type { getAutoDiagStats } from "../tools/registerLspTools.js";
import type { getWorkspaceScopeStats } from "../tools/workspaceStats.js";

export interface LspStatusSnapshot {
  config: LoadLspConfigResult;
  lockfile: LspLockfile;
  processes: LspProcessEntry[];
  /** Cumulative auto-diag outcomes, when auto-diag has run this session. */
  autoDiagStats?: ReturnType<typeof getAutoDiagStats>;
  /** Cumulative outside-workspace refusals for this session. */
  workspaceScopeStats?: ReturnType<typeof getWorkspaceScopeStats>;
}

export function formatLspStatus(snapshot: LspStatusSnapshot): string {
  const lines = ["LSP status", ""];
  lines.push(`installMode: ${snapshot.config.installMode}`);
  lines.push(`warmup: ${snapshot.config.warmup ? "enabled" : "disabled"}`);
  lines.push(`servers: ${Object.keys(snapshot.config.catalog.servers).length}`);
  lines.push(`tracked processes: ${snapshot.processes.length}`);

  if (snapshot.config.warnings.length > 0) {
    lines.push("", "warnings:");
    for (const warning of snapshot.config.warnings) lines.push(`- ${warning}`);
  }

  lines.push("", "servers:");
  for (const server of Object.values(snapshot.config.catalog.servers)) {
    const installed = snapshot.lockfile.servers[server.id] ? "installed" : "missing";
    const processCount = snapshot.processes.filter((process) => process.serverId === server.id).length;
    // Always show the bound in effect: a server relying on the default is the
    // common case, and a coverage collapse is impossible to diagnose without
    // seeing what it was waiting for.
    const wait = server.diagnosticsWaitMs ?? DEFAULT_DIAGNOSTICS_WAIT_MS;
    lines.push(
      `- ${server.id}: ${installed}, ${processCount} process${processCount === 1 ? "" : "es"}, diagnosticsWaitMs ${wait}` +
        (server.diagnosticsWaitMs === undefined ? " (default)" : ""),
    );
  }

  const stats = snapshot.autoDiagStats;
  if (stats && stats.edits > 0) {
    lines.push("", "auto-diag outcomes:");
    lines.push(`- edits handled: ${stats.edits}`);
    lines.push(`- steers emitted: ${stats.emitted}`);
    lines.push(`- no new errors: ${stats.no_new_errors}`);
    lines.push(`- no baseline: ${stats.no_baseline}`);
    lines.push(
      `- not published in time: ${stats.not_published} (${((100 * stats.not_published) / stats.edits).toFixed(1)}% of edits)`,
    );
    lines.push(`- no client for file: ${stats.no_client}`);
    lines.push(`- failed edits: ${stats.edit_failed}`);
  }

  const scope = snapshot.workspaceScopeStats;
  const scopeTotal = scope ? scope.toolRefusals + scope.warmupRefusals + scope.baselineRefusals : 0;
  if (scope && scope.autoAdded > 0) {
    lines.push("", "workspace roots added automatically:");
    for (const root of scope.autoAddedRoots) lines.push(`- ${root}`);
  }
  if (scope && scopeTotal > 0) {
    lines.push("", "outside-workspace refusals (this session, cumulative):");
    lines.push(`- total: ${scopeTotal} (${scope.distinctPaths} distinct paths)`);
    lines.push(`- from LSP tools: ${scope.toolRefusals}`);
    lines.push(`- from read warmup: ${scope.warmupRefusals}`);
    lines.push(`- from auto-diag baseline: ${scope.baselineRefusals}`);
    if (scope.repeats > 0) {
      lines.push(`- repeat hits on an already-refused path: ${scope.repeats}`);
    }
    if (scope.lastSuggestedRoot) {
      lines.push(`- last suggested root: ${scope.lastSuggestedRoot}`);
    }
  }

  return lines.join("\n");
}

export function formatLspDoctor(snapshot: LspStatusSnapshot, serverId?: string): string {
  if (serverId) {
    const server = snapshot.config.catalog.servers[serverId];
    if (!server) return `Unknown LSP server: ${serverId}`;
    return formatServerDoctor(server, snapshot);
  }

  return [formatLspStatus(snapshot), "", "Run /lsp doctor <serverId> for resolved server details."].join("\n");
}

function formatServerDoctor(server: ServerDefinition, snapshot: LspStatusSnapshot): string {
  const lockEntry = snapshot.lockfile.servers[server.id];
  const processes = snapshot.processes.filter((process) => process.serverId === server.id);
  const lines = [
    `server: ${server.id}`,
    `displayName: ${server.displayName}`,
    `filetypes: ${server.filetypes.join(", ")}`,
    `rootMarkers: ${server.rootMarkers.join(", ")}`,
    `install: ${server.install.type}`,
    `lazy: ${server.lazy ? "yes" : "no"}`,
    `installed: ${lockEntry ? "yes" : "no"}`,
  ];

  if (lockEntry) {
    lines.push(`resolvedCommand: ${lockEntry.resolvedCommand.join(" ")}`);
    if (lockEntry.requestedVersion) lines.push(`requestedVersion: ${lockEntry.requestedVersion}`);
    if (lockEntry.packageDir) lines.push(`packageDir: ${lockEntry.packageDir}`);
  }

  if (processes.length > 0) {
    lines.push("processes:");
    for (const process of processes) {
      lines.push(`- pid ${process.pid} root=${process.rootDir} owner=${process.ownerId}`);
    }
  } else {
    lines.push("processes: none");
  }

  const relevantWarnings = snapshot.config.warnings.filter((warning) => warning.includes(server.id));
  if (relevantWarnings.length > 0) {
    lines.push("warnings:");
    for (const warning of relevantWarnings) lines.push(`- ${warning}`);
  }

  return lines.join("\n");
}
