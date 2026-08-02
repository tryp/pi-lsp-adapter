import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { messageFromError } from "./util/helpers.js";
import { loadLspConfig } from "./config/loadConfig.js";
import { LspInstallManager } from "./install/manager.js";
import { ensureManagedLspRoot } from "./install/lockfile.js";
import { LspProcessRegistry } from "./lsp/processRegistry.js";
import { LspRuntimeManager } from "./lsp/runtimeManager.js";
import { registerLspCommand } from "./commands/registerCommands.js";
import { registerLspTools } from "./tools/registerLspTools.js";
import { registerLspWarmup } from "./tools/registerLspWarmup.js";
import { LspResultCache } from "./tools/resultCache.js";
import { setLspStatusLine } from "./statusLine.js";
import type { LspExtensionState } from "./state.js";

export default function piAgentLspExtension(pi: ExtensionAPI): void {
  let state: LspExtensionState | null = null;
  let generation = 0;

  registerLspCommand(pi, () => state);
  registerLspTools(pi, () => state);
  registerLspWarmup(pi, () => state);

  pi.on("before_agent_start", (event) => {
    if (!state) return;

    // Build compact LSP server summary from the actual catalog
    const servers = state.config.catalog.servers;
    const serverIds = Object.keys(servers);
    const ftToExt: Record<string, string> = {
      python: ".py", typescript: ".ts", typescriptreact: ".tsx",
      javascript: ".js", javascriptreact: ".jsx",
      go: ".go", rust: ".rs", java: ".java",
      json: ".json", jsonc: ".jsonc", yaml: ".yaml/.yml",
      markdown: ".md/.mdx",
    };
    const allFts = new Set<string>();
    for (const id of serverIds) {
      for (const ft of servers[id].filetypes) allFts.add(ft);
    }
    const extList = [...allFts].sort().map((ft) => ftToExt[ft] || ft).join(", ");
    const serverList = serverIds
      .map((id) => `${id}(${servers[id].filetypes.join(",")})`)
      .join(", ");

    const serverBlock = serverIds.length > 0
      ? `\n\n**Available LSP servers (${serverIds.length}):** ${serverList}\nLSP tools work on: ${extList}. Call lsp_list_workspace_roots for full server details with display names.`
      : "";

    return {
      systemPrompt: `${event.systemPrompt}\n\n**EFFICIENCY RULES (follow strictly):**\n- To discover functions/classes/variables -> lsp_document_symbols (NOT read). After it, do NOT read for structure — the symbol tree is complete.\n- To check lint/type errors after editing -> lsp_diagnostics FIRST. Only read specific flagged lines.\n- To get type/signature/docs -> lsp_hover. Do NOT read surrounding block — hover returns the full type info.\n- To find definitions -> lsp_definition (NOT grep/read).\n- To assess rename impact -> lsp_references (NOT grep).\n- When lsp_diagnostics shows fixable errors -> lsp_code_action with apply=True to auto-fix.\n- For actual code body -> read specific line range (after lsp_document_symbols).\n\nWhen LSP result says "More available" with resultId, use lsp_more for next page. For hover/definition/references, put column on identifier. LSP uses 1-based line/col. Output is compact (file:line:col) — LSP calls survive compaction better than file reads.

**Cross-project analysis:**
- LSP tools are limited to project directory scopes.
- Use lsp_add_workspace_root to add external directories into scope.
- Use lsp_list_workspace_roots to see all directories in scope.${serverBlock}\n`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    const currentGeneration = ++generation;
    const previousState = state;
    state = null;

    await shutdownState(previousState, ctx, "session_restart");
    if (currentGeneration !== generation) return;

    const ownerId = createOwnerId();
    try {
      await ensureManagedLspRoot();
      const config = await loadLspConfig({
        cwd: ctx.cwd,
        projectRoot: ctx.cwd,
      });
      const processRegistry = new LspProcessRegistry({ ownerId });
      const recovery = await processRegistry.cleanupStaleProcesses();
      const installManager = new LspInstallManager({
        catalog: config.catalog,
        installMode: config.installMode,
        confirmer: ctx.hasUI
          ? async ({ server, command }) =>
              ctx.ui.confirm(
                `Install ${server.displayName}?`,
                `Run ${command}?`,
              )
          : undefined,
      });
      const runtimeManager = new LspRuntimeManager({
        cwd: ctx.cwd,
        ownerId,
        config,
        installManager,
        processRegistry,
        extraWorkspaceRoots: config.extraWorkspaceRoots,
      });
      const resultCache = new LspResultCache();

      const nextState: LspExtensionState = {
        ownerId,
        cwd: ctx.cwd,
        config,
        installManager,
        processRegistry,
        runtimeManager,
        resultCache,
        lastRecovery: {
          terminated: recovery.terminated.length,
          removed: recovery.removed.length,
          kept: recovery.kept.length,
        },
      };

      if (currentGeneration !== generation) {
        await shutdownState(nextState, ctx, "stale_session_start");
        return;
      }

      state = nextState;
      setLspStatusLine(ctx, nextState);
      notifyStartup(ctx, nextState);
    } catch (error) {
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("error", "LSP: failed"));
      if (ctx.hasUI)
        ctx.ui.notify(
          `LSP initialization failed: ${messageFromError(error)}`,
          "error",
        );
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ++generation;
    const currentState = state;
    state = null;
    await shutdownState(currentState, ctx, "session_shutdown");
  });
}

async function shutdownState(
  state: LspExtensionState | null,
  ctx: ExtensionContext,
  _reason: "session_restart" | "session_shutdown" | "stale_session_start",
): Promise<void> {
  if (!state) return;

  try {
    state.resultCache.clear();
    await state.runtimeManager.shutdown();
    const result = await state.processRegistry.terminateOwnedProcesses();
    if (ctx.hasUI && result.terminated.length > 0) {
      ctx.ui.notify(
        `LSP: stopped ${result.terminated.length} process(es).`,
        "info",
      );
    }
  } catch (error) {
    if (ctx.hasUI)
      ctx.ui.notify(
        `LSP shutdown cleanup failed: ${messageFromError(error)}`,
        "error",
      );
  } finally {
    ctx.ui.setStatus("lsp", undefined);
  }
}

function notifyStartup(ctx: ExtensionContext, state: LspExtensionState): void {
  if (!ctx.hasUI) return;
  const recovery = state.lastRecovery;
  if (recovery && recovery.terminated + recovery.removed > 0) {
    ctx.ui.notify(
      `LSP recovered ${recovery.terminated + recovery.removed} stale pid entr${recovery.terminated + recovery.removed === 1 ? "y" : "ies"}.`,
      "info",
    );
  }
}

function createOwnerId(): string {
  return `pi-lsp-${process.pid}-${randomUUID()}`;
}
