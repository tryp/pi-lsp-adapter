import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { delay } from "../util/helpers.js";
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeAction,
  Command,
  Definition,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  SymbolInformation,
  WorkspaceEdit,
  WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import { URI } from "vscode-uri";
import { detectFiletype } from "../detect/filetypes.js";
import { detectRoot } from "../detect/root.js";
import type { LoadLspConfigResult } from "../config/loadConfig.js";
import type { LspInstallManager } from "../install/manager.js";
import { readLockfile, type LockfileOptions } from "../install/lockfile.js";
import type {
  InstalledServerMetadata,
  ServerDefinition,
} from "../registry/schema.js";
import { resolveServerConfig } from "../resolve/resolveServer.js";
import type { LspProcessRegistry } from "./processRegistry.js";
import {
  LspClient,
  type LspConnectionFactory,
  type LspDiagnosticsResult,
  type LspServerSpawner,
} from "./client.js";

export interface LspRuntimeManagerOptions {
  cwd: string;
  ownerId: string;
  config: LoadLspConfigResult;
  installManager: LspInstallManager;
  processRegistry: LspProcessRegistry;
  spawner?: LspServerSpawner;
  connectionFactory?: LspConnectionFactory;
  lockfileOptions?: LockfileOptions;
  requestTimeoutMs?: number;
  /**
   * Fallback post-edit diagnostics wait bound, used when a server sets no
   * `diagnosticsWaitMs` of its own.
   */
  diagnosticsWaitMs?: number;
  shutdownGraceMs?: number;
  extraWorkspaceRoots?: string[];
}

/**
 * Default post-edit diagnostics wait bound, in milliseconds.
 *
 * Measured with `scripts/lsp_publish_latency.py` against real servers: vtsls
 * and pyright on a small project publish within ~260ms, while pyright on a
 * large Python project takes 1.5-2.3s per edit. The old 350ms default matched
 * the fast case only, and session analysis of the 2026-10-03 deploy showed the
 * result: steer coverage on covered edits fell from 40% to 8%, because every
 * slow-server publication missed the bound and the read silently returned
 * without a steer.
 *
 * 5s is roughly twice the p95 measured on the slow case. It costs nothing when
 * the server answers quickly because the wait ends as soon as the matching
 * publication arrives; it only bounds the pathological case where the server
 * never publishes at all.
 */
export const DEFAULT_DIAGNOSTICS_WAIT_MS = 5_000;

/**
 * Hard ceiling for any configured diagnostics wait.
 *
 * An edit's tool_result handler awaits this wait, so the bound is on the
 * agent's critical path, and per-server config can come from a project
 * checkout the user has not trusted. Long enough for a very slow server on a
 * very large project (the measured worst case was ~2.3s), short enough that a
 * hostile value cannot hold a turn open for ten minutes.
 */
export const MAX_DIAGNOSTICS_WAIT_MS = 30_000;

export type LspStartStatus =
  | "started"
  | "already-running"
  | "missing"
  | "declined"
  | "error";

export interface LspStartResult {
  serverId: string;
  rootDir: string;
  status: LspStartStatus;
  message: string;
  installedNow?: boolean;
}

export interface LspRuntimeFileResult<T> {
  serverId: string;
  rootDir: string;
  filePath: string;
  uri: string;
  result: T;
}

export interface LspWorkspaceSymbolsResult {
  serverId: string;
  rootDir: string;
  result: SymbolInformation[] | WorkspaceSymbol[] | null;
}

interface SelectedServer {
  server: ServerDefinition;
  rootDir: string;
  rootMarker?: string;
  filetype: string;
  filePath: string;
  text: string;
}

interface ClientTarget {
  client: LspClient;
  serverId: string;
  rootDir: string;
  started: boolean;
}

interface ClientShutdownResult {
  client: LspClient;
  stopped: boolean;
}

interface ClientStartOptions {
  allowPromptInstall: boolean;
  allowAutoInstall?: boolean;
}

interface EnsureClientInput {
  server: ServerDefinition;
  rootDir: string;
  rootMarker?: string;
  allowPromptInstall: boolean;
  allowAutoInstall?: boolean;
}

interface StartClientInput extends EnsureClientInput {
  key: string;
}

export class LspRuntimeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "no-filetype"
      | "no-server"
      | "not-installed"
      | "declined"
      | "start-failed"
      | "outside-workspace"
      | "invalid-position"
      | "add-workspace-root-error",
  ) {
    super(message);
    this.name = "LspRuntimeError";
  }
}

export class LspRuntimeManager {
  private readonly cwd: string;
  private readonly extraWorkspaceRoots: string[];
  private workspaceRoots: string[];
  private readonly ownerId: string;
  private readonly config: LoadLspConfigResult;
  private readonly installManager: LspInstallManager;
  private readonly processRegistry: LspProcessRegistry;
  private readonly spawner?: LspServerSpawner;
  private readonly connectionFactory?: LspConnectionFactory;
  private readonly lockfileOptions: LockfileOptions;
  private readonly requestTimeoutMs: number;
  private readonly diagnosticsWaitMs: number;
  private readonly shutdownGraceMs: number;
  private readonly clients = new Map<string, LspClient>();
  private readonly starting = new Map<string, Promise<ClientTarget>>();
  private readonly filetypeCache = new Map<string, string>();

  constructor(options: LspRuntimeManagerOptions) {
    this.cwd = options.cwd;
    this.extraWorkspaceRoots = options.extraWorkspaceRoots ?? [];
    this.workspaceRoots = [
      this.cwd,
      ...this.extraWorkspaceRoots.map((r) => resolve(r)),
    ];
    this.ownerId = options.ownerId;
    this.config = options.config;
    this.installManager = options.installManager;
    this.processRegistry = options.processRegistry;
    this.spawner = options.spawner;
    this.connectionFactory = options.connectionFactory;
    this.lockfileOptions = options.lockfileOptions ?? {};
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.diagnosticsWaitMs = options.diagnosticsWaitMs ?? DEFAULT_DIAGNOSTICS_WAIT_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 1_000;
  }

  async startServer(
    serverId?: string,
    options: ClientStartOptions = { allowPromptInstall: false },
  ): Promise<LspStartResult[]> {
    const targets = serverId ? [serverId] : await this.installedServerIds();
    if (targets.length === 0) return [];

    const results: LspStartResult[] = [];
    for (const targetId of targets) {
      results.push(await this.startServerAtRoot(targetId, this.cwd, options));
    }
    return results;
  }

  async restartServer(
    serverId?: string,
    options: ClientStartOptions = { allowPromptInstall: false },
  ): Promise<LspStartResult[]> {
    const targetIds = new Set(
      serverId
        ? [serverId]
        : [...this.clients.values()].map((client) => client.serverId),
    );
    if (!serverId && targetIds.size === 0) {
      return this.startServer(undefined, options);
    }

    const stopped = await this.shutdownClients((client) =>
      targetIds.has(client.serverId),
    );
    const failed = stopped.filter((entry) => !entry.stopped);
    if (failed.length > 0) {
      return failed.map(({ client }) => ({
        serverId: client.serverId,
        rootDir: client.rootDir,
        status: "error",
        message: `Could not restart ${client.serverId} for ${client.rootDir}; old process did not exit.`,
      }));
    }

    return this.startServer(serverId, options);
  }

  /**
   * Add a directory to the LSP workspace roots so files under it can be
   * inspected with LSP tools. Does not start a server immediately — servers
   * are started lazily when a file from the new root is first queried.
   *
   * Returns the resolved absolute path and whether it was newly added.
   *
   * Throws LspRuntimeError with code "add-workspace-root-error" if the path
   * does not exist or is not a directory.
   */
  async addWorkspaceRoot(
    dir: string,
  ): Promise<{ resolved: string; added: boolean }> {
    const resolved = resolve(dir);

    if (this.isInsideAnyWorkspace(resolved)) {
      return { resolved, added: false };
    }

    // Check the path exists and is a directory
    try {
      const stat = await import("node:fs/promises").then((m) =>
        m.stat(resolved),
      );
      if (!stat.isDirectory()) {
        throw new LspRuntimeError(
          `Cannot add workspace root ${resolved}: path is not a directory.`,
          "add-workspace-root-error",
        );
      }
    } catch (error) {
      if (error instanceof LspRuntimeError) throw error;
      throw new LspRuntimeError(
        `Cannot add workspace root ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
        "add-workspace-root-error",
      );
    }

    this.workspaceRoots.push(resolved);
    return { resolved, added: true };
  }

  /**
   * List all active workspace roots currently in scope.
   */
  listWorkspaceRoots(): string[] {
    return [...this.workspaceRoots];
  }

  async shutdown(): Promise<void> {
    this.filetypeCache.clear();
    await this.shutdownClients(() => true);
  }

  async stopServer(serverId?: string): Promise<number> {
    const stopped = await this.shutdownClients(
      (client) => !serverId || client.serverId === serverId,
    );
    return stopped.filter((entry) => entry.stopped).length;
  }

  async warmupFile(filePath: string): Promise<boolean> {
    try {
      const selected = await this.selectServerForFile(filePath);
      const target = await this.ensureClient({
        server: selected.server,
        rootDir: selected.rootDir,
        rootMarker: selected.rootMarker,
        allowPromptInstall: false,
        allowAutoInstall: false,
      });
      await target.client.syncFile(
        selected.filePath,
        selected.filetype,
        selected.text,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read diagnostics for a file from an ALREADY-ACTIVE client, without
   * starting a server, reading the file, or syncing anything.
   *
   * Used for the auto-diag pre-edit baseline: the baseline must reflect the
   * document state that was live before the edit, so it must not race the
   * edit by re-reading the file or mutating the client's document.
   *
   * Returns undefined when there is no usable baseline. Prefers the client
   * whose root actually contains the file, so a file covered by more than one
   * client (nested roots, multiple servers for one filetype) does not get
   * another client's diagnostics.
   */
  cachedDiagnostics(filePath: string): Diagnostic[] | undefined {
    const resolvedPath = this.resolvePath(filePath);
    const uri = URI.file(resolvedPath).toString();
    const candidates = [...this.clients.values()].filter(
      (entry) => !entry.isExited && entry.hasDocument(uri),
    );
    if (candidates.length === 0) return undefined;

    // Longest matching root wins: the most specific project owns the file.
    // Ties (equal roots) are broken by serverId so the choice is stable
    // rather than dependent on client insertion order.
    const owner = candidates
      .filter((entry) => isPathInside(entry.rootDir, resolvedPath))
      .sort(
        (a, b) =>
          b.rootDir.length - a.rootDir.length ||
          a.serverId.localeCompare(b.serverId),
      )[0];
    if (!owner && candidates.length > 1) {
      // Several clients could own the file and none contains it. Choosing
      // arbitrarily would mis-attribute errors, so report no baseline.
      return undefined;
    }
    const client = owner ?? candidates[0];

    return client.getPublishedDiagnostics(uri);
  }

  async diagnostics(filePath: string): Promise<LspDiagnosticsResult> {
    const target = await this.prepareFileTarget(filePath);
    const published = await this.waitForPublishedDiagnostics(
      target.client,
      target.uri,
      target.seqBeforeSync,
    );
    return {
      serverId: target.client.serverId,
      rootDir: target.client.rootDir,
      filePath: target.filePath,
      uri: target.uri,
      diagnostics: target.client.getDiagnostics(target.uri),
      published,
    };
  }

  /**
   * Wait for diagnostics that correspond to the document version we just
   * synced, bounded by the server's configured wait.
   *
   * A fixed delay is a guess: too short reads the previous version's
   * diagnostics (already-fixed errors reported as new), too long wastes a
   * turn. Two signals let us do better than guessing, in order of precision:
   *
   *  1. The document version the server echoes on `publishDiagnostics`, when
   *     it sends one. Anything below the version we synced is the previous
   *     edit's answer -- including a publication that was merely still in
   *     flight when we sampled, which on a slow server can arrive seconds
   *     after the edit that caused it.
   *  2. The client's own publication counter, sampled before the sync. Servers
   *     may omit `version` entirely (it is optional in the protocol), so this
   *     is what distinguishes "published in response to my sync" from
   *     "published some time ago". Without it, a version-less server would
   *     return a stale publication immediately.
   *
   * Signal 1 wins whenever the server echoes a version, and signal 2 is only a
   * fallback for servers that never do: the counter alone cannot tell a fresh
   * publication from a late answer to the previous edit.
   *
   * Polls rather than sleeping for the whole bound, so the common case costs
   * one publication latency rather than the entire wait. Expiry returns false
   * so the caller never mistakes an unrefreshed cache for a clean file.
   */
  private async waitForPublishedDiagnostics(
    client: LspClient,
    uri: string,
    seqBeforeSync: number,
  ): Promise<boolean> {
    const syncedVersion = client.getDocumentVersion(uri);
    const deadline = performance.now() + this.diagnosticsWaitMsFor(client.serverId);

    // Order matters: the version signal is checked first and the counter is
    // only a fallback for servers that omit `version`. Checking the counter
    // first would accept any publication newer than the sample, including a
    // late answer to the *previous* edit -- exactly the stale read this
    // function exists to prevent.
    //
    // The version-less case used to sleep for the whole bound and then accept
    // whatever was cached. Polling the publication counter instead is both
    // faster and stricter.
    const arrived = () => {
      const publishedVersion = client.getPublishedVersion(uri);
      if (syncedVersion !== undefined && publishedVersion !== undefined) {
        return publishedVersion >= syncedVersion;
      }
      const publishedSeq = client.getPublishedSeq(uri);
      return publishedSeq !== undefined && publishedSeq > seqBeforeSync;
    };

    while (!arrived()) {
      const remaining = deadline - performance.now();
      // Report the truth on timeout: the caller must not treat an
      // unpublished (or stale) cache as "this file is clean".
      if (remaining <= 0) return false;
      await delay(Math.min(25, Math.max(1, remaining)));
    }
    return true;
  }

  /**
   * Resolve the post-edit diagnostics wait bound for one server.
   *
   * Precedence: the server's own `diagnosticsWaitMs`, then the manager-wide
   * option, then {@link DEFAULT_DIAGNOSTICS_WAIT_MS}. The result is clamped:
   * this wait sits on the agent's critical path (an edit does not return until
   * it resolves), and config can come from an untrusted project checkout, so a
   * hostile value must not be able to stall a turn indefinitely.
   */
  private diagnosticsWaitMsFor(serverId: string): number {
    const configured = this.config.catalog.servers[serverId]?.diagnosticsWaitMs;
    const resolved =
      typeof configured === "number" && Number.isFinite(configured) && configured >= 0
        ? configured
        : this.diagnosticsWaitMs;
    return Math.min(resolved, MAX_DIAGNOSTICS_WAIT_MS);
  }

  /**
   * Runs diagnostics AND queries code actions at a generic position.
   * Returns both so the caller can annotate each diagnostic with fix availability.
   */
  async diagnosticsWithFixes(
    filePath: string,
  ): Promise<{
    diagnostics: LspDiagnosticsResult;
    codeActions: LspRuntimeFileResult<(CodeAction | Command)[] | null>;
    diagnosticActions: Array<{ diagnosticIndex: number; actionTitles: string[] }>;
  }> {
    const diagResult = await this.diagnostics(filePath);

    // Sort diagnostics consistently so indices align with formatDiagnostics output
    const allDiags = [...diagResult.diagnostics].sort(compareRawDiagnostics);

    if (allDiags.length === 0) {
      // A server without codeActionProvider must not turn a clean file into a
      // throw: callers use this result to decide whether the file is covered
      // at all, and a failed fix lookup says nothing about coverage.
      let codeActions: LspRuntimeFileResult<(CodeAction | Command)[] | null>;
      try {
        codeActions = await this.codeAction(filePath, 1, 1, undefined, true);
      } catch {
        codeActions = {
          serverId: diagResult.serverId,
          rootDir: diagResult.rootDir,
          filePath: diagResult.filePath,
          uri: URI.file(filePath).toString(),
          result: null,
        };
      }
      return {
        diagnostics: diagResult,
        codeActions,
        diagnosticActions: [],
      };
    }

    // Query code actions at each diagnostic position with that diagnostic as context.
    // This lets LSP servers return per-diagnostic scoped actions when they support it.
    // When they return file-wide actions (e.g. ruff-lsp's source.fixAll),
    // the empty diagnostics field means they cover all diagnostics.
    const uniqueActions = new Map<string, CodeAction>();
    let primaryServerId = "";
    let primaryUri = "";
    const diagnosticActions: Array<{ diagnosticIndex: number; actionTitles: string[] }> = [];

    // Collect per-diagnostic actions by querying at each position
    for (let i = 0; i < allDiags.length && i < 10; i++) {
      const d = allDiags[i];
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;

      let caResult: LspRuntimeFileResult<(CodeAction | Command)[] | null>;
      try {
        caResult = await this.codeAction(filePath, line, col, [d], true);
      } catch {
        continue;
      }
      const actions = caResult.result ?? [];

      if (!primaryServerId) {
        primaryServerId = caResult.serverId;
        primaryUri = caResult.uri;
      }

      const titles: string[] = [];
      for (const action of actions) {
        if ("title" in action && !("command" in action)) {
          const ca = action as CodeAction;
          const actionDiags = ca.diagnostics ?? [];
          const matches =
            actionDiags.length === 0 ||
            actionDiags.some(
              (ad) =>
                ad.message === d.message &&
                ad.range.start.line === d.range.start.line &&
                ad.range.start.character === d.range.start.character,
            );
          if (matches && !uniqueActions.has(ca.title)) {
            uniqueActions.set(ca.title, ca);
          }
          if (matches) {
            titles.push(ca.title);
          }
        }
      }
      diagnosticActions.push({ diagnosticIndex: i, actionTitles: titles });
    }

    // Always also try generic position to catch file-wide actions
    // that may not appear at every diagnostic position.
    let genericActions: (CodeAction | Command)[] = [];
    try {
      const genericResult = await this.codeAction(filePath, 1, 1, undefined, true);
      genericActions = genericResult.result ?? [];
      if (!primaryServerId) {
        primaryServerId = genericResult.serverId;
        primaryUri = genericResult.uri;
      }
    } catch {
      // ignore
    }
    // Collect any file-wide actions (those with no per-diagnostic scope)
    const fileWideTitles: string[] = [];
    for (const action of genericActions) {
      if ("title" in action && !("command" in action)) {
        const ca = action as CodeAction;
        if (!uniqueActions.has(ca.title)) {
          uniqueActions.set(ca.title, ca);
        }
        // Actions with no diagnostics field are file-wide; they cover everything
        if ((ca.diagnostics ?? []).length === 0) {
          if (!fileWideTitles.includes(ca.title)) {
            fileWideTitles.push(ca.title);
          }
        }
      }
    }

    // Apply file-wide actions to any diagnostics that don't have specific actions yet
    if (fileWideTitles.length > 0) {
      for (let i = 0; i < allDiags.length; i++) {
        const existing = diagnosticActions.find((da) => da.diagnosticIndex === i);
        if (existing && existing.actionTitles.length === 0) {
          existing.actionTitles.push(...fileWideTitles);
        } else if (!existing) {
          diagnosticActions.push({
            diagnosticIndex: i,
            actionTitles: [...fileWideTitles],
          });
        }
      }
      // Also ensure warnings without their own actions get covered
      for (const action of genericActions) {
        if ("title" in action && !("command" in action)) {
          const ca = action as CodeAction;
          if (ca.diagnostics && ca.diagnostics.length > 0) {
            // Per-diagnostic scoped actions: match by position
            for (let i = 0; i < allDiags.length; i++) {
              const d = allDiags[i];
              const matched = ca.diagnostics.some(
                (ad) =>
                  ad.message === d.message &&
                  ad.range.start.line === d.range.start.line,
              );
              if (matched) {
                const existing = diagnosticActions.find((da) => da.diagnosticIndex === i);
                if (existing) {
                  if (!existing.actionTitles.includes(ca.title)) {
                    existing.actionTitles.push(ca.title);
                  }
                } else {
                  diagnosticActions.push({ diagnosticIndex: i, actionTitles: [ca.title] });
                }
              }
            }
          }
        }
      }
    }

    return {
      diagnostics: diagResult,
      codeActions: {
        serverId: primaryServerId,
        rootDir: diagResult.rootDir,
        filePath: diagResult.filePath,
        uri: primaryUri,
        result: Array.from(uniqueActions.values()),
      },
      diagnosticActions,
    };
  }

  async hover(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspRuntimeFileResult<Hover | null>> {
    const target = await this.prepareFilePositionTarget(
      filePath,
      line,
      character,
    );
    return {
      serverId: target.client.serverId,
      rootDir: target.client.rootDir,
      filePath: target.filePath,
      uri: target.uri,
      result: await target.client.hover(target.uri, line, character),
    };
  }

  async definition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspRuntimeFileResult<Definition | LocationLink[] | null>> {
    const target = await this.prepareFilePositionTarget(
      filePath,
      line,
      character,
    );
    return {
      serverId: target.client.serverId,
      rootDir: target.client.rootDir,
      filePath: target.filePath,
      uri: target.uri,
      result: await target.client.definition(target.uri, line, character),
    };
  }

  async references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration = false,
  ): Promise<LspRuntimeFileResult<Location[] | null>> {
    const target = await this.prepareFilePositionTarget(
      filePath,
      line,
      character,
    );
    return {
      serverId: target.client.serverId,
      rootDir: target.client.rootDir,
      filePath: target.filePath,
      uri: target.uri,
      result: await target.client.references(
        target.uri,
        line,
        character,
        includeDeclaration,
      ),
    };
  }

  async documentSymbols(
    filePath: string,
  ): Promise<
    LspRuntimeFileResult<DocumentSymbol[] | SymbolInformation[] | null>
  > {
    const target = await this.prepareFileTarget(filePath);
    return {
      serverId: target.client.serverId,
      rootDir: target.client.rootDir,
      filePath: target.filePath,
      uri: target.uri,
      result: await target.client.documentSymbols(target.uri),
    };
  }

  async codeAction(
    filePath: string,
    line: number,
    character: number,
    diagnostics?: Diagnostic[],
    skipFallback?: boolean,
  ): Promise<LspRuntimeFileResult<(CodeAction | Command)[] | null>> {
    const target = await this.prepareFilePositionTarget(
      filePath,
      line,
      character,
    );
    const context = diagnostics ? { diagnostics } : undefined;
    let result = await target.client.codeAction(target.uri, line, character, context);
    let serverId = target.client.serverId;
    let rootDir = target.client.rootDir;

    // If the primary server returned no code actions, try a fallback server
    // for the same filetype (e.g. ruff for lint auto-fixes when pyright
    // returns empty).
    // Skip fallback in auto-diag path (diagnosticsWithFixes) because secondary
    // servers like ruff-lsp only offer file-wide lint actions (Organize Imports)
    // that don't actually fix the specific diagnostic — they just create noise.
    if (!skipFallback && (!result || result.length === 0)) {
      const fallback = this.findFallbackCodeActionServer(
        target.server,
        target.filetype,
      );
      if (fallback) {
        try {
          const fbTarget = await this.attachClient({
            server: fallback,
            rootDir: target.rootDir,
            rootMarker: undefined,
            filetype: target.filetype,
            filePath: target.filePath,
            text: target.text,
          });
          const fbResult = await fbTarget.client.codeAction(
            fbTarget.uri,
            line,
            character,
            context,
          );
          if (fbResult && fbResult.length > 0) {
            result = fbResult;
            serverId = fbTarget.client.serverId;
            rootDir = fbTarget.client.rootDir;
          }
        } catch {
          // Fallback failed silently -- keep original empty result
        }
      }
    }

    return {
      serverId,
      rootDir,
      filePath: target.filePath,
      uri: target.uri,
      result,
    };
  }

  /**
   * Queries code actions at the given position, finds the action matching
   * `actionTitle`, extracts its WorkspaceEdit, and applies the text edits
   * to disk. Returns a summary of what was changed.
   */
  async applyCodeAction(
    filePath: string,
    line: number,
    character: number,
    actionTitle: string,
  ): Promise<{
    serverId: string;
    rootDir: string;
    filePath: string;
    actionTitle: string;
    actionKind?: string;
    changes: number;
    files: string[];
    error?: string;
  }> {
    const result = await this.codeAction(filePath, line, character);
    const actions = result.result ?? [];

    // Find the action by title (case-insensitive)
    const match = actions.find(
      (a): a is CodeAction =>
        "title" in a &&
        a.title.trim().toLowerCase() === actionTitle.trim().toLowerCase(),
    );
    if (!match) {
      const available = actions
        .map((a) => ("title" in a ? `"${a.title}"` : "(command)"))
        .join(", ");
      return {
        serverId: result.serverId,
        rootDir: result.rootDir,
        filePath: result.filePath,
        actionTitle,
        changes: 0,
        files: [],
        error: `No action matching "${actionTitle}". Available: ${available}`,
      };
    }

    const edit = match.edit;
    if (!edit) {
      return {
        serverId: result.serverId,
        rootDir: result.rootDir,
        filePath: result.filePath,
        actionTitle,
        actionKind: match.kind,
        changes: 0,
        files: [],
        error: `Action "${actionTitle}" has no associated WorkspaceEdit.`,
      };
    }

    const fileSet = new Set<string>();
    let totalChanges = 0;

    // Apply changes (simple format: TextEdit[] per URI)
    if (edit.changes) {
      for (const [uri, textEdits] of Object.entries(edit.changes)) {
        const fsPath = uriToFsPath(uri);
        fileSet.add(fsPath);
        totalChanges += (textEdits as Array<unknown>).length;
        await applyTextEdits(fsPath, textEdits);
      }
    }

    // Apply documentChanges (extended format: TextDocumentEdit)
    if (edit.documentChanges) {
      for (const dc of edit.documentChanges) {
        if ("edits" in dc) {
          const tde = dc as { textDocument: { uri: string }; edits: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }> };
          const fsPath = uriToFsPath(tde.textDocument.uri);
          fileSet.add(fsPath);
          totalChanges += tde.edits.length;
          await applyTextEdits(fsPath, tde.edits);
        }
        // CreateFile, RenameFile, DeleteFile are skipped (rare for code actions)
      }
    }

    return {
      serverId: result.serverId,
      rootDir: result.rootDir,
      filePath: result.filePath,
      actionTitle,
      actionKind: match.kind,
      changes: totalChanges,
      files: [...fileSet],
    };
  }

  async rename(
    filePath: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<LspRuntimeFileResult<WorkspaceEdit | null>> {
    const target = await this.prepareFilePositionTarget(
      filePath,
      line,
      character,
    );
    return {
      serverId: target.client.serverId,
      rootDir: target.client.rootDir,
      filePath: target.filePath,
      uri: target.uri,
      result: await target.client.rename(target.uri, line, character, newName),
    };
  }

  async implementation(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspRuntimeFileResult<Location | LocationLink[] | null>> {
    const target = await this.prepareFilePositionTarget(
      filePath,
      line,
      character,
    );
    return {
      serverId: target.client.serverId,
      rootDir: target.client.rootDir,
      filePath: target.filePath,
      uri: target.uri,
      result: await target.client.implementation(target.uri, line, character),
    };
  }

  async typeDefinition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspRuntimeFileResult<Location | LocationLink[] | null>> {
    const target = await this.prepareFilePositionTarget(
      filePath,
      line,
      character,
    );
    return {
      serverId: target.client.serverId,
      rootDir: target.client.rootDir,
      filePath: target.filePath,
      uri: target.uri,
      result: await target.client.typeDefinition(target.uri, line, character),
    };
  }

  async callHierarchy(
    filePath: string,
    line: number,
    character: number,
    direction: "incoming" | "outgoing",
  ): Promise<
    LspRuntimeFileResult<
      CallHierarchyIncomingCall[] | CallHierarchyOutgoingCall[] | null
    >
  > {
    const target = await this.prepareFilePositionTarget(
      filePath,
      line,
      character,
    );
    const items = await target.client.prepareCallHierarchy(
      target.uri,
      line,
      character,
    );
    if (!items || items.length === 0) {
      return {
        serverId: target.client.serverId,
        rootDir: target.client.rootDir,
        filePath: target.filePath,
        uri: target.uri,
        result: null,
      };
    }
    const result =
      direction === "incoming"
        ? await target.client.callHierarchyIncomingCalls(items[0])
        : await target.client.callHierarchyOutgoingCalls(items[0]);
    return {
      serverId: target.client.serverId,
      rootDir: target.client.rootDir,
      filePath: target.filePath,
      uri: target.uri,
      result,
    };
  }

  async workspaceSymbols(
    query: string,
    serverId?: string,
    options: ClientStartOptions = { allowPromptInstall: false },
  ): Promise<LspWorkspaceSymbolsResult[]> {
    const clients = serverId
      ? [
          await this.ensureClient({
            server: this.getServer(serverId),
            rootDir: this.cwd,
            allowPromptInstall: options.allowPromptInstall,
          }),
        ]
      : this.workspaceSymbolClients();
    const results: LspWorkspaceSymbolsResult[] = [];
    for (const target of clients) {
      try {
        const result = await target.client.workspaceSymbols(query);
        if (result) {
          results.push({
            serverId: target.client.serverId,
            rootDir: target.client.rootDir,
            result,
          });
        }
      } catch (e) {
        // When no specific serverId was requested, skip clients that
        // don't support workspace symbols (e.g., ruff-lsp, ruff —
        // linter-only servers). When a specific server is requested,
        // surface the error so the user knows the server can't
        // fulfill the request.
        if (serverId) throw e;
      }
    }
    return results;
  }

  activeClients(): Array<{ id: string; serverId: string; rootDir: string }> {
    const active: Array<{ id: string; serverId: string; rootDir: string }> = [];
    for (const client of this.clients.values()) {
      if (!client.isExited)
        active.push({
          id: client.id,
          serverId: client.serverId,
          rootDir: client.rootDir,
        });
    }
    return active;
  }

  private workspaceSymbolClients(): ClientTarget[] {
    const active: ClientTarget[] = [];
    for (const client of this.clients.values()) {
      if (!client.isExited)
        active.push({
          client,
          serverId: client.serverId,
          rootDir: client.rootDir,
          started: false,
        });
    }
    return active;
  }

  private async prepareFileTarget(
    filePath: string,
  ): Promise<SelectedServer & { client: LspClient; uri: string; seqBeforeSync: number }> {
    const selected = await this.selectServerForFile(filePath);
    return this.attachClient(selected);
  }

  private async prepareFilePositionTarget(
    filePath: string,
    line: number,
    character: number,
  ): Promise<SelectedServer & { client: LspClient; uri: string }> {
    const selected = await this.selectServerForFile(filePath);
    validatePosition(selected, line, character);
    return this.attachClient(selected);
  }

  private async attachClient(
    selected: SelectedServer,
  ): Promise<SelectedServer & { client: LspClient; uri: string; seqBeforeSync: number }> {
    const target = await this.ensureClient({
      server: selected.server,
      rootDir: selected.rootDir,
      rootMarker: selected.rootMarker,
      allowPromptInstall: false,
    });
    // Sample the publication counter immediately before syncing: any
    // publication with a higher sequence arrived as a result of this sync and
    // therefore describes the content we are about to report on. Servers that
    // omit the optional `version` field cannot be matched by version alone.
    const seqBeforeSync = target.client.getPublicationSeq();
    const uri = await target.client.syncFile(
      selected.filePath,
      selected.filetype,
      selected.text,
    );
    return { ...selected, client: target.client, uri, seqBeforeSync };
  }

  private async selectServerForFile(filePath: string): Promise<SelectedServer> {
    const resolvedPath = this.resolvePath(filePath);
    const text = await readFile(resolvedPath, "utf8");
    const cached = this.filetypeCache.get(resolvedPath);
    const filetype =
      cached ?? detectFiletype({ path: resolvedPath, content: text });
    if (cached === undefined) {
      if (filetype) this.filetypeCache.set(resolvedPath, filetype);
    }
    if (!filetype) {
      throw new LspRuntimeError(
        `No LSP filetype detected for ${resolvedPath}.`,
        "no-filetype",
      );
    }

    const server = Object.values(this.config.catalog.servers).find((entry) =>
      entry.filetypes.includes(filetype),
    );
    if (!server) {
      throw new LspRuntimeError(
        `No configured LSP server handles filetype ${filetype} for ${resolvedPath}.`,
        "no-server",
      );
    }

    const root = await detectRoot(resolvedPath, server.rootMarkers);
    const rootDir =
      root && this.isInsideAnyWorkspace(root.rootDir) ? root.rootDir : this.cwd;
    return {
      server,
      rootDir,
      rootMarker: rootDir === root?.rootDir ? root.marker : undefined,
      filetype,
      filePath: resolvedPath,
      text,
    };
  }

  private async startServerAtRoot(
    serverId: string,
    rootDir: string,
    options: ClientStartOptions,
  ): Promise<LspStartResult> {
    try {
      const target = await this.ensureClient({
        server: this.getServer(serverId),
        rootDir,
        allowPromptInstall: options.allowPromptInstall,
      });
      return {
        serverId,
        rootDir: target.rootDir,
        status: target.started ? "started" : "already-running",
        message: target.started
          ? `Started ${serverId} for ${target.rootDir}.`
          : `${serverId} is already running for ${target.rootDir}.`,
      };
    } catch (error) {
      if (
        error instanceof LspRuntimeError &&
        (error.code === "not-installed" || error.code === "declined")
      ) {
        return {
          serverId,
          rootDir,
          status: error.code === "not-installed" ? "missing" : "declined",
          message: error.message,
        };
      }
      return {
        serverId,
        rootDir,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private getServer(serverId: string): ServerDefinition {
    const server = this.config.catalog.servers[serverId];
    if (!server)
      throw new LspRuntimeError(
        `Unknown LSP server: ${serverId}.`,
        "no-server",
      );
    return server;
  }

  /**
   * Find a fallback server for code actions when the primary server returns
   * empty results. Uses the first configured server that handles the same
   * filetype but is not the current server (e.g. ruff for Python lint fixes
   * when pyright returns no code actions).
   */
  private findFallbackCodeActionServer(
    currentServer: ServerDefinition,
    filetype: string,
  ): ServerDefinition | undefined {
    return Object.values(this.config.catalog.servers).find(
      (entry) =>
        entry.id !== currentServer.id &&
        entry.filetypes.includes(filetype),
    );
  }

  private async ensureClient(input: EnsureClientInput): Promise<ClientTarget> {
    const server = input.server;
    const rootDir = resolve(input.rootDir);
    const key = clientKey(server.id, rootDir);
    const existing = this.clients.get(key);
    if (existing && !existing.isExited) {
      return { client: existing, serverId: server.id, rootDir, started: false };
    }

    const inflight = this.starting.get(key);
    if (inflight) return inflight;

    const start = this.startClient({ ...input, rootDir, key });
    this.starting.set(key, start);
    try {
      return await start;
    } finally {
      this.starting.delete(key);
    }
  }

  private async startClient(input: StartClientInput): Promise<ClientTarget> {
    const install = await this.ensureInstalled(input.server.id, {
      allowPromptInstall: input.allowPromptInstall,
      allowAutoInstall: input.allowAutoInstall,
    });
    const resolved = await resolveServerConfig({
      server: input.server,
      rootDir: input.rootDir,
      rootMarker: input.rootMarker,
      install,
    });
    let client: LspClient | undefined;
    try {
      client = new LspClient({
        id: input.key,
        ownerId: this.ownerId,
        config: resolved,
        processRegistry: this.processRegistry,
        spawner: this.spawner,
        connectionFactory: this.connectionFactory,
        requestTimeoutMs: this.requestTimeoutMs,
        shutdownGraceMs: this.shutdownGraceMs,
      });
      await client.start();
      this.clients.set(input.key, client);
      return {
        client,
        serverId: input.server.id,
        rootDir: input.rootDir,
        started: true,
      };
    } catch (error) {
      await client?.shutdown().catch(() => false);
      throw new LspRuntimeError(
        `Failed to start ${input.server.id}: ${error instanceof Error ? error.message : String(error)}`,
        "start-failed",
      );
    }
  }

  private async ensureInstalled(
    serverId: string,
    options: ClientStartOptions,
  ): Promise<InstalledServerMetadata> {
    const lockfile = await readLockfile(this.lockfileOptions);
    const existing = lockfile.servers[serverId];
    if (existing) return existing;

    if (
      !options.allowPromptInstall &&
      (!(options.allowAutoInstall ?? true) ||
        this.config.installMode !== "auto")
    ) {
      throw new LspRuntimeError(
        `${serverId} is not installed. Run /lsp install ${serverId} to install it explicitly.`,
        "not-installed",
      );
    }

    const result = await this.installManager.ensureInstalled(serverId);
    if (result.status === "installed") return result.metadata;
    throw new LspRuntimeError(
      result.message,
      result.status === "declined" ? "declined" : "not-installed",
    );
  }

  private async installedServerIds(): Promise<string[]> {
    const lockfile = await readLockfile(this.lockfileOptions);
    return Object.keys(lockfile.servers).filter(
      (serverId) => this.config.catalog.servers[serverId] !== undefined,
    );
  }

  private async shutdownClients(
    predicate: (client: LspClient) => boolean,
  ): Promise<ClientShutdownResult[]> {
    const entries = [...this.clients.entries()].filter(([_key, client]) =>
      predicate(client),
    );
    const stopped = await Promise.all(
      entries.map(async ([key, client]) => {
        const didStop = await client.shutdown();
        if (didStop || client.isExited) this.clients.delete(key);
        return { client, stopped: didStop || client.isExited };
      }),
    );
    return stopped;
  }

  private resolvePath(filePath: string): string {
    const resolvedPath = isAbsolute(filePath)
      ? resolve(filePath)
      : resolve(this.cwd, filePath);
    if (!this.isInsideAnyWorkspace(resolvedPath)) {
      throw new LspRuntimeError(
        `Refusing to start LSP for ${resolvedPath}; target is outside workspace ${this.cwd}.`,
        "outside-workspace",
      );
    }
    return resolvedPath;
  }

  private isInsideAnyWorkspace(targetPath: string): boolean {
    return this.workspaceRoots.some((root) => isPathInside(root, targetPath));
  }
}

function clientKey(serverId: string, rootDir: string): string {
  return `${serverId}:${rootDir}`;
}

function isPathInside(rootDir: string, targetPath: string): boolean {
  const relativePath = relative(resolve(rootDir), resolve(targetPath));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function validatePosition(
  selected: SelectedServer,
  line: number,
  character: number,
): void {
  const lines = splitLines(selected.text);
  if (
    !Number.isInteger(line) ||
    !Number.isInteger(character) ||
    line < 0 ||
    character < 0
  ) {
    throw new LspRuntimeError(
      `Invalid LSP position for ${selected.filePath}. Use a valid 1-based line/column from the file and place the column on an identifier token.`,
      "invalid-position",
    );
  }

  if (line >= lines.length) {
    throw new LspRuntimeError(
      `Position is outside ${selected.filePath}: line ${line + 1} was requested, but the file has ${lines.length} line(s). Use a valid 1-based line/column from the file and place the column on an identifier token.`,
      "invalid-position",
    );
  }

  const maxCharacter = lines[line]?.length ?? 0;
  if (character > maxCharacter) {
    throw new LspRuntimeError(
      `Position is outside ${selected.filePath}: column ${character + 1} was requested on line ${line + 1}, but the maximum column is ${maxCharacter + 1}. Place the column on the identifier token you want to inspect.`,
      "invalid-position",
    );
  }
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/u);
}

/** Sort Diagnostic[] by severity (error first) then position. */
function compareRawDiagnostics(a: Diagnostic, b: Diagnostic): number {
  const sevA = a.severity ?? 4;
  const sevB = b.severity ?? 4;
  if (sevA !== sevB) return sevA - sevB;
  const lineDiff = a.range.start.line - b.range.start.line;
  if (lineDiff !== 0) return lineDiff;
  return a.range.start.character - b.range.start.character;
}

function uriToFsPath(uri: string): string {
  return URI.parse(uri).fsPath;
}

interface TextEditLike {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

/**
 * Applies a list of TextEdits to a file on disk.
 * Edits are sorted in reverse order (by line, then character descending)
 * so that earlier positions are not shifted by later edits.
 */
async function applyTextEdits(fsPath: string, edits: TextEditLike[]): Promise<void> {
  const text = await readFile(fsPath, "utf8");
  const lines = text.split("\n");

  // Sort edits in reverse order so they don't interfere
  const sorted = [...edits].sort((a, b) => {
    const lineDiff = b.range.start.line - a.range.start.line;
    if (lineDiff !== 0) return lineDiff;
    return b.range.start.character - a.range.start.character;
  });

  for (const edit of sorted) {
    const startLine = edit.range.start.line;
    const startCol = edit.range.start.character;
    const endLine = edit.range.end.line;
    const endCol = edit.range.end.character;

    if (startLine === endLine) {
      // Single-line edit
      const line = lines[startLine];
      lines[startLine] = line.slice(0, startCol) + edit.newText + line.slice(endCol);
    } else {
      // Multi-line edit: replace range with newText
      const firstPart = lines[startLine].slice(0, startCol);
      const lastPart = lines[endLine].slice(endCol);
      const middle = edit.newText;
      lines.splice(startLine, endLine - startLine + 1, firstPart + middle + lastPart);
    }
  }

  await writeFile(fsPath, lines.join("\n"), "utf8");
}
