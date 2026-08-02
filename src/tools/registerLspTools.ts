import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { Type } from "typebox";
import type { Diagnostic } from "vscode-languageserver-types";
import type { LspExtensionState } from "../state.js";
import { setLspStatusLine } from "../statusLine.js";
import type { LspDiagnosticsResult } from "../lsp/client.js";
import {
  failure,
  success,
  formatCallHierarchy,
  formatCodeActions,
  formatDefinition,
  formatDiagnostics,
  formatDiagnosticsWithFixes,
  formatDocumentSymbols,
  formatHover,
  formatImpact,
  formatImplementations,
  formatReferences,
  formatRenameEdit,
  formatTypeDefinition,
  formatWorkspaceSymbols,
  toLspPosition,
} from "./lspFormat.js";
import { LSP_RESULT_ID_LENGTH, LSP_RESULT_ID_PATTERN } from "./resultCache.js";
import { ImpactParams, resolveSymbols, analyzeImpact, formatAmbiguity } from "./lspImpact.js";

// ─── Auto-diagnostics on edit/write ────────────────────────────────────
//
// Caches pre-mutation diagnostics so we can report only *new* errors
// introduced by an edit or write. Errors with LSP code-action fixes
// are annotated so the agent can apply them with lsp_code_action(apply).
//
// Gated behind --auto-diag (boolean flag, default off).

const pendingBeforeDiags = new Map<string, Diagnostic[]>();

function sortDiags(a: Diagnostic, b: Diagnostic): number {
  if (a.range.start.line !== b.range.start.line)
    return a.range.start.line - b.range.start.line;
  if (a.range.start.character !== b.range.start.character)
    return a.range.start.character - b.range.start.character;
  const msgCmp = a.message.localeCompare(b.message);
  if (msgCmp !== 0) return msgCmp;
  return String(a.code ?? "").localeCompare(String(b.code ?? ""));
}

function registerAutoDiag(pi: ExtensionAPI, getState: GetLspToolState): void {
  pi.registerFlag("auto-diag", {
    description:
      "After every edit/write, run diagnostics and steer the agent if new" +
      " lint/type errors were introduced. On by default.",
    type: "boolean",
    default: true,
  });

  // Snapshot pre-mutation diagnostics so we can diff post-mutation.
  pi.on("tool_call", (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const filePath = event.input.path;
    if (!filePath || typeof filePath !== "string") return;

    const state = getState();
    if (!state) return;

    // Fire-and-forget — diagnostics reads cached LSP state, near-instant.
    state.runtimeManager
      .diagnostics(filePath)
      .then((r: LspDiagnosticsResult) => {
        pendingBeforeDiags.set(`${event.toolCallId}:${filePath}`, r.diagnostics);
      })
      .catch(() => {});
  });

  // Compare post-mutation diagnostics against cached pre-state; steer on new errors.
  pi.on("tool_result", async (event, _ctx) => {
    if (event.isError) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const filePath = (event.input as { path?: string }).path;
    if (!filePath) return;

    const enabled = pi.getFlag("auto-diag");
    if (!enabled) return;

    const state = getState();
    if (!state) return;

    const cacheKey = `${event.toolCallId}:${filePath}`;
    const before = pendingBeforeDiags.get(cacheKey);
    pendingBeforeDiags.delete(cacheKey);

    // Run diagnostics + query code actions on post-mutation state.
    let afterResult: {
      diagnostics: LspDiagnosticsResult;
      diagnosticActions: Array<{ diagnosticIndex: number; actionTitles: string[] }>;
    };
    try {
      afterResult = await state.runtimeManager.diagnosticsWithFixes(filePath);
    } catch {
      return; // LSP doesn't cover this file type — nothing to report.
    }

    const rawAfter = afterResult.diagnostics.diagnostics;

    // Sort both arrays identically so diagnosticActions indices align.
    const sortedBefore = (before ?? []).sort(sortDiags);
    const sortedAfter = [...rawAfter].sort(sortDiags);

    // Build a Set-key for each before-diagnostic for O(n) lookup.
    const beforeKeys = new Set(
      sortedBefore.map(
        (d) => `${d.range.start.line}:${d.range.start.character}:${d.message}:${d.code ?? ""}`,
      ),
    );

    // Collect new Error-severity diagnostics (DiagnosticSeverity.Error === 1).
    type DaEntry = { diagnosticIndex: number; actionTitles: string[] };
    const diagActionMap = new Map<number, string[]>(
      afterResult.diagnosticActions.map((da: DaEntry) => [da.diagnosticIndex, da.actionTitles]),
    );

    interface NewDiag {
      d: Diagnostic;
      sortedIndex: number;
    }
    const newErrors: NewDiag[] = [];
    for (let i = 0; i < sortedAfter.length; i++) {
      const d = sortedAfter[i];
      if (d.severity !== 1) continue;
      const key = `${d.range.start.line}:${d.range.start.character}:${d.message}:${d.code ?? ""}`;
      if (beforeKeys.has(key)) continue;
      newErrors.push({ d, sortedIndex: i });
    }

    if (newErrors.length === 0) return;

    // Build steer message.
    const lines: string[] = [];
    let fixableCount = 0;

    for (let i = 0; i < newErrors.length && i < 5; i++) {
      const { d, sortedIndex } = newErrors[i];
      const fixTitles = diagActionMap.get(sortedIndex);
      const hasFix = fixTitles && fixTitles.length > 0;
      if (hasFix) fixableCount++;
      const fixSuffix = hasFix
        ? ` [Fix: "${fixTitles![0]}"]`
        : "";
      const codeStr = d.code ? ` (${d.code})` : "";
      lines.push(`  L${d.range.start.line + 1}${codeStr} ${d.message}${fixSuffix}`);
    }

    const overflow =
      newErrors.length > 5
        ? `\n  ... and ${newErrors.length - 5} more`
        : "";

    const fixHint =
      fixableCount > 0
        ? ` (${fixableCount} fixable)`
        : "";

    const body =
      `[auto-diag] ${filePath}: ${newErrors.length} new error(s)${fixHint}\n` +
      lines.join("\n") +
      overflow +
      "\n" +
      `Use \`lsp_code_action\` with \`apply\` to apply an available fix.`;

    pi.sendMessage(
      {
        customType: "auto_diag",
        content: body,
        display: false,  // invisible in UI; still written to session file
                          // but skipped on session restore (see session-manager.ts)
      },
      { deliverAs: "steer" },
    );
  });
}

export type GetLspToolState = () => LspExtensionState | null;

function registerToolPromptGuidelines(pi: ExtensionAPI): void {
  pi.registerToolPromptGuidelines("read", [
    "To get file structure use lsp_document_symbols first — returns tree with line numbers, no file content. After calling it, do NOT read the same file for structure — the tree is complete.",
    "To get type/signature/docs use lsp_hover on the identifier. Do NOT read the surrounding code block — hover returns full type info compactly.",
    "To find where a symbol is defined use lsp_definition on the identifier instead of grep + read.",
    "To check for lint/type errors use lsp_diagnostics first instead of reading the whole file. Only read specific flagged lines.",
  ]);
  pi.registerToolPromptGuidelines("grep", [
    "To find ALL usages of a symbol across the workspace use lsp_references — returns file:line:col directly, no grep needed.",
    "To find where a symbol is defined use lsp_definition on the identifier — exact file:line:col, more reliable than grep.",
    "To search for functions, classes, or other symbols by name without knowing file paths use lsp_workspace_symbols with kind=\"function,class,method\" etc.",
    "To find symbols by partial name across all file types use lsp_workspace_symbols instead of grep — returns typed results with file:line locations.",
  ]);
  pi.registerToolPromptGuidelines("remind", [
    "When checking on a background job, use bash_bg with remindDelay instead of manual remind() — the callback auto-cancels if the job completes before the timer fires.",
    "Use manual remind() only for standalone reminders that aren't linked to a job.",
  ]);
}

const FilePathParams = Type.Object({
  filePath: Type.String({ description: "Path to the source file to inspect." }),
  checkFixes: Type.Optional(
    Type.Boolean({
      description: "When true, also queries lsp_code_action and annotates each diagnostic with fix availability.",
    }),
  ),
});

const FilePositionParams = Type.Object({
  filePath: Type.String({ description: "Path to the source file to inspect." }),
  line: Type.Integer({ minimum: 1, description: "1-based line number." }),
  column: Type.Integer({
    minimum: 1,
    description:
      "1-based column/character number. For symbol queries, place it on the identifier token.",
  }),
});

const ReferencesParams = Type.Object({
  filePath: Type.String({ description: "Path to the source file to inspect." }),
  line: Type.Integer({ minimum: 1, description: "1-based line number." }),
  column: Type.Integer({
    minimum: 1,
    description:
      "1-based column/character number. For symbol queries, place it on the identifier token.",
  }),
  includeDeclaration: Type.Optional(
    Type.Boolean({
      description: "Whether to include the symbol declaration in the result.",
    }),
  ),
});

const WorkspaceSymbolsParams = Type.Object({
  query: Type.String({ description: "Workspace symbol query string." }),
  kind: Type.Optional(
    Type.String({
      description:
        "Filter by symbol kind: comma-separated list, e.g. \"function,class,method\". " +
        "Accepted: file, module, namespace, package, class, method, property, field, " +
        "constructor, enum, interface, function, variable, constant, string, number, " +
        "boolean, array, object, key, null, enumMember, struct, event, operator, typeParameter.",
    }),
  ),
  serverId: Type.Optional(
    Type.String({
      description: "Optional LSP server id to query, e.g. pyright or vtsls.",
    }),
  ),
});

const MoreParams = Type.Object({
  resultId: Type.String({
    description:
      "Exact cached LSP resultId returned by a previous paginated LSP tool result.",
    pattern: LSP_RESULT_ID_PATTERN,
    minLength: LSP_RESULT_ID_LENGTH,
    maxLength: LSP_RESULT_ID_LENGTH,
  }),
});

const CodeActionParams = Type.Object({
  filePath: Type.String({ description: "Path to the source file to inspect." }),
  line: Type.Integer({ minimum: 1, description: "1-based line number." }),
  column: Type.Integer({
    minimum: 1,
    description:
      "1-based column/character number. Place it on the identifier or error token.",
  }),
  apply: Type.Optional(
    Type.String({
      description:
        "Optional title of a code action to apply (e.g. 'Ruff: Fix All'). When provided, the action's WorkspaceEdit is executed and files are modified.",
    }),
  ),
});

const CallHierarchyParams = Type.Object({
  filePath: Type.String({ description: "Path to the source file to inspect." }),
  line: Type.Integer({ minimum: 1, description: "1-based line number." }),
  column: Type.Integer({
    minimum: 1,
    description:
      "1-based column/character number. Place it on the identifier token.",
  }),
  direction: Type.String({
    description: "Direction of call hierarchy: 'incoming' or 'outgoing'.",
  }),
});

const RenameParams = Type.Object({
  filePath: Type.String({ description: "Path to the source file to inspect." }),
  line: Type.Integer({
    minimum: 1,
    description: "1-based line number of the symbol to rename.",
  }),
  column: Type.Integer({
    minimum: 1,
    description:
      "1-based column/character number. Place it on the symbol identifier to rename.",
  }),
  newName: Type.String({ description: "The new name for the symbol." }),
});

const AddWorkspaceRootParams = Type.Object({
  directory: Type.String({
    description:
      "Directory path to add to LSP workspace scope. Can be absolute or relative to the current project.",
  }),
});

const ListWorkspaceRootsParams = Type.Object({});

export function registerLspTools(
  pi: ExtensionAPI,
  getState: GetLspToolState,
): void {
  registerToolPromptGuidelines(pi);
  registerAutoDiag(pi, getState);
  pi.registerTool<typeof FilePathParams, unknown>({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description:
      "Read diagnostics for a file using its configured language server. Returns only severity/source/code/line:col per issue, no file content transferred. Supported file types depend on which LSP servers are configured — use lsp_list_workspace_roots to see what's available.",
    promptSnippet:
      "Inspect compiler/type/lint diagnostics from configured language servers for a file.",
    promptGuidelines: [
      "Use lsp_diagnostics after reading or editing code when semantic errors, type errors, or language-server diagnostics would help.",
      "Returns only filepath/line/column of issues — no file content transferred.",
    ],
    parameters: FilePathParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state)
        return failure("lsp_diagnostics", "LSP extension is not initialized.");
      try {
        if (params.checkFixes) {
          const both = await state.runtimeManager.diagnosticsWithFixes(params.filePath);
          const result = formatDiagnosticsWithFixes(
            both.diagnostics,
            both.codeActions,
            both.diagnosticActions,
            state.resultCache,
          );
          refreshStatus(ctx, state);
          return result;
        }
        const result = formatDiagnostics(
          await state.runtimeManager.diagnostics(params.filePath),
          state.resultCache,
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_diagnostics", error);
      }
    },
  });

  pi.registerTool<typeof FilePositionParams, unknown>({
    name: "lsp_hover",
    label: "LSP Hover",
    description:
      "Get hover/type information for a symbol at a 1-based line and column. Works on any file type with a configured LSP server (including .md via marksman) — use lsp_list_workspace_roots to see which servers are active.",
    promptSnippet:
      "Fetch hover/type information for a symbol at a 1-based line and column.",
    promptGuidelines: [
      "Use lsp_hover when you need symbol type, signature, or docs. Put line/column on the identifier token, not whitespace or surrounding syntax.",
      "Do NOT read the surrounding code block after hover — hover returns the full type info compactly.",
    ],
    parameters: FilePositionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state)
        return failure("lsp_hover", "LSP extension is not initialized.");
      try {
        const position = toLspPosition(params);
        const result = formatHover(
          await state.runtimeManager.hover(
            params.filePath,
            position.line,
            position.character,
          ),
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_hover", error);
      }
    },
  });

  pi.registerTool<typeof FilePositionParams, unknown>({
    name: "lsp_definition",
    label: "LSP Definition",
    description:
      "Find definition locations for the symbol at a source position. line and column are 1-based. On .md files this navigates to heading, anchor, and wiki-link targets. Use lsp_list_workspace_roots to see configured servers.",
    promptSnippet:
      "Jump to definitions for a symbol at a 1-based line and column.",
    promptGuidelines: [
      "Use lsp_definition before changing unfamiliar call sites, types, or imported symbols. Put line/column on the identifier token, not import path strings.",
      "Returns file:line:column targets only — no file content transferred.",
    ],
    parameters: FilePositionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state)
        return failure("lsp_definition", "LSP extension is not initialized.");
      try {
        const position = toLspPosition(params);
        const result = formatDefinition(
          await state.runtimeManager.definition(
            params.filePath,
            position.line,
            position.character,
          ),
          state.resultCache,
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_definition", error);
      }
    },
  });

  pi.registerTool<typeof ReferencesParams, unknown>({
    name: "lsp_references",
    label: "LSP References",
    description:
      "Find references for the symbol at a source position. line and column are 1-based. On .md files this finds backlinks to headings, tags, and wiki-link targets. Use lsp_list_workspace_roots to see configured servers.",
    promptSnippet: "Find references for a symbol at a 1-based line and column.",
    promptGuidelines: [
      "Use lsp_references to assess impact before renames, API changes, or behavior changes. Put line/column on the identifier token itself; set includeDeclaration when you need the declaration included in the results.",
      "Returns all reference locations across the workspace as file:line:column — no file content transferred. Much more efficient than grep + read.",
    ],
    parameters: ReferencesParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state)
        return failure("lsp_references", "LSP extension is not initialized.");
      try {
        const position = toLspPosition(params);
        const result = formatReferences(
          await state.runtimeManager.references(
            params.filePath,
            position.line,
            position.character,
            params.includeDeclaration ?? false,
          ),
          state.resultCache,
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_references", error);
      }
    },
  });

  pi.registerTool<typeof FilePathParams, unknown>({
    name: "lsp_document_symbols",
    label: "LSP Document Symbols",
    description:
      "List symbols in a source file using its configured language server. Only needs filePath — no line/col required. Works on .md files (headings, sections) and all other file types with configured LSP servers — use lsp_list_workspace_roots to see what's available.",
    promptSnippet:
      "List functions, classes, variables, and other symbols in a source file.",
    promptGuidelines: [
      "Use lsp_document_symbols INSTEAD OF reading L1-60 for file structure. Returns tree of all functions/classes/variables with line numbers. After calling it, do NOT also read the file for structure — the tree is complete.",
      "After lsp_document_symbols, use lsp_hover on specific lines for signature info instead of reading the code block.",
    ],
    parameters: FilePathParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state)
        return failure(
          "lsp_document_symbols",
          "LSP extension is not initialized.",
        );
      try {
        const result = formatDocumentSymbols(
          await state.runtimeManager.documentSymbols(params.filePath),
          state.resultCache,
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_document_symbols", error);
      }
    },
  });

  pi.registerTool<typeof WorkspaceSymbolsParams, unknown>({
    name: "lsp_workspace_symbols",
    label: "LSP Workspace Symbols",
    description:
      "Search symbols across active LSP workspaces. Optionally filter by kind and/or provide a server id.",
    promptSnippet:
      "Search workspace symbols by name across active language-server sessions.",
    promptGuidelines: [
      "Use lsp_workspace_symbols to locate definitions or related symbols by partial name when file paths are unknown. More efficient than grep for named symbols.",
      "Optionally set kind to filter results to specific symbol types, e.g. kind=\"function,class,method\" to see only function/class/method definitions.",
      "Omit serverId to query active servers only; provide a configured serverId to start/query a specific server.",
      "Returns matching symbols with file:line locations — no file content transferred.",
    ],
    parameters: WorkspaceSymbolsParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state)
        return failure(
          "lsp_workspace_symbols",
          "LSP extension is not initialized.",
        );
      try {
        const raw = await state.runtimeManager.workspaceSymbols(
          params.query,
          params.serverId,
        );
        const result = formatWorkspaceSymbols(
          raw,
          state.resultCache,
          { query: params.query, kind: params.kind },
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_workspace_symbols", error);
      }
    },
  });

  pi.registerTool<typeof MoreParams, unknown>({
    name: "lsp_more",
    label: "LSP More Results",
    description:
      "Return the next cached page from a previous paginated LSP result.",
    promptSnippet:
      "Fetch the next sequential page for a previous LSP resultId without re-querying the language server.",
    promptGuidelines: [
      "Use lsp_more only when the previous LSP result explicitly says 'More available' and provides a resultId. Cached pages are sequential and may expire after cache eviction or session restart; if a resultId is missing or expired, re-run the original LSP query.",
    ],
    parameters: MoreParams,
    async execute(_toolCallId, params) {
      const state = getState();
      if (!state)
        return failure("lsp_more", "LSP extension is not initialized.");
      return state.resultCache.next(params.resultId);
    },
  });

  pi.registerTool<typeof CodeActionParams, unknown>({
    name: "lsp_code_action",
    label: "LSP Code Action",
    description:
      "Get available code actions (quick fixes, refactors, source actions) at a source position. Returns actions like add import, fix lint, extract method, or organize imports.",
    promptSnippet:
      "Get available code actions (quick fixes, refactors, source actions) at a source position.",
    promptGuidelines: [
      "Use lsp_code_action after lsp_diagnostics returns errors — the LSP returns concrete actions like 'Add import X from Y', 'Remove unused variable foo', or 'Fix this lint error'.",
      "Place the column on the identifier or error token where you want code actions.",
      "Returns a list of available actions with their kinds and whether they're preferred.",
    ],
    parameters: CodeActionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state)
        return failure("lsp_code_action", "LSP extension is not initialized.");
      try {
        // If an action title was specified, apply it rather than listing
        if (params.apply) {
          const position = toLspPosition(params);
          const result = await state.runtimeManager.applyCodeAction(
            params.filePath,
            position.line,
            position.character,
            params.apply,
          );
          refreshStatus(ctx, state);
          if (result.error) {
            return success(
              `Applied code action "${params.apply}": ${result.error}`,
              { ...result, ok: false },
            );
          }
          const fileList = result.files.join(", ");
          return success(
            `Applied code action "${params.apply}" on ${result.filePath} (${result.serverId}):\n` +
              `${result.changes} change(s) across ${result.files.length} file(s): ${fileList}`,
            { ...result, ok: true },
          );
        }
        const position = toLspPosition(params);
        const caResult = await state.runtimeManager.codeAction(
          params.filePath,
          position.line,
          position.character,
        );
        const result = formatCodeActions(caResult, state.resultCache);
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_code_action", error);
      }
    },
  });

  pi.registerTool<typeof RenameParams, unknown>({
    name: "lsp_rename",
    label: "LSP Rename",
    description:
      "Rename a symbol across the entire workspace using language server intelligence. Provides a summary of all files and occurrences changed.",
    promptSnippet:
      "Rename a symbol across the workspace using the language server.",
    promptGuidelines: [
      "Use lsp_rename for safe workspace-wide renaming instead of manual grep-and-edit. One LSP call replaces references across all files.",
      "Place the column on the symbol identifier to rename. Provide the new name as a string.",
      "Returns a summary of files changed and occurrence count. Currently returns the edit summary for review — direct file application is a future enhancement.",
      "The rename will fail if the symbol is not renamable (e.g., language keywords, built-in names). Call lsp_definition first to verify the symbol exists.",
    ],
    parameters: RenameParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state)
        return failure("lsp_rename", "LSP extension is not initialized.");
      try {
        const position = toLspPosition(params);
        const result = formatRenameEdit(
          await state.runtimeManager.rename(
            params.filePath,
            position.line,
            position.character,
            params.newName,
          ),
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_rename", error);
      }
    },
  });

  pi.registerTool<typeof FilePositionParams, unknown>({
    name: "lsp_implementation",
    label: "LSP Implementation",
    description:
      "Find implementation locations for the symbol at a source position. Navigates from an interface or abstract method to concrete implementations.",
    promptSnippet:
      "Find implementations for a symbol at a 1-based line and column.",
    promptGuidelines: [
      "Use lsp_implementation to navigate from an interface or abstract method to its concrete implementations.",
      "Returns file:line:column targets for each implementation.",
    ],
    parameters: FilePositionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state)
        return failure(
          "lsp_implementation",
          "LSP extension is not initialized.",
        );
      try {
        const position = toLspPosition(params);
        const result = formatImplementations(
          await state.runtimeManager.implementation(
            params.filePath,
            position.line,
            position.character,
          ),
          state.resultCache,
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_implementation", error);
      }
    },
  });

  pi.registerTool<typeof FilePositionParams, unknown>({
    name: "lsp_type_definition",
    label: "LSP Type Definition",
    description:
      "Find type definition locations for the symbol at a source position. Goes from a value to its type definition (e.g., from a variable to its type's definition).",
    promptSnippet:
      "Find type definition for a symbol at a 1-based line and column.",
    promptGuidelines: [
      "Use lsp_type_definition to go from a value to its type definition. In TypeScript, at a variable declaration this navigates to the type's definition, not the variable's.",
      "Returns a single file:line:column target.",
    ],
    parameters: FilePositionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state)
        return failure(
          "lsp_type_definition",
          "LSP extension is not initialized.",
        );
      try {
        const position = toLspPosition(params);
        const result = formatTypeDefinition(
          await state.runtimeManager.typeDefinition(
            params.filePath,
            position.line,
            position.character,
          ),
          state.resultCache,
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_type_definition", error);
      }
    },
  });

  pi.registerTool<typeof CallHierarchyParams, unknown>({
    name: "lsp_call_hierarchy",
    label: "LSP Call Hierarchy",
    description:
      "Show call hierarchy for the symbol at a source position. Use 'incoming' to see what calls this symbol, or 'outgoing' to see what this symbol calls.",
    promptSnippet:
      "Show call hierarchy (incoming/outgoing) for a symbol at a 1-based line and column.",
    promptGuidelines: [
      "Use lsp_call_hierarchy for impact analysis before refactoring.",
      "Set direction to 'incoming' to see what calls this function, or 'outgoing' to see what this function calls.",
      "Returns call hierarchy items with file:line:column locations.",
    ],
    parameters: CallHierarchyParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state)
        return failure(
          "lsp_call_hierarchy",
          "LSP extension is not initialized.",
        );
      try {
        const position = toLspPosition(params);
        const result = formatCallHierarchy(
          await state.runtimeManager.callHierarchy(
            params.filePath,
            position.line,
            position.character,
            params.direction,
          ),
          params.direction,
          state.resultCache,
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_call_hierarchy", error);
      }
    },
  });

  pi.registerTool<typeof AddWorkspaceRootParams, unknown>({
    name: "lsp_add_workspace_root",
    label: "LSP Add Workspace Root",
    description:
      "Add a directory into the LSP workspace scope so that files under it " +
      "can be analyzed with LSP tools. The directory must exist. " +
      "Once added, subsequent LSP queries for files under this path will " +
      "work as if they were inside the project directory. " +
      "Accepts both absolute and relative (to cwd) paths.",
    promptSnippet:
      "Add a directory to the LSP workspace scope for cross-project analysis.",
    promptGuidelines: [
      "Use lsp_add_workspace_root when you need to analyze source code outside the current project directory.",
      "The directory must exist on disk. Returns the resolved path and whether it was newly added.",
      "LSP servers are started lazily — a file from the new root is analyzed on first query.",
      "Use lsp_list_workspace_roots to see all directories currently in scope.",
    ],
    parameters: AddWorkspaceRootParams,
    async execute(_toolCallId, params) {
      const state = getState();
      if (!state)
        return failure(
          "lsp_add_workspace_root",
          "LSP extension is not initialized.",
        );
      try {
        const result = await state.runtimeManager.addWorkspaceRoot(
          params.directory,
        );
        if (result.added) {
          return success(`Added ${result.resolved} to LSP workspace scope.`, {
            added: true,
            resolved: result.resolved,
          });
        }
        return success(`${result.resolved} is already in LSP workspace scope.`, {
          added: false,
          resolved: result.resolved,
        });
      } catch (error) {
        return failure("lsp_add_workspace_root", error);
      }
    },
  });

  pi.registerTool<typeof ImpactParams, unknown>({
    name: "lsp_impact",
    label: "LSP Impact Analysis",
    description:
      "Multi-symbol blast radius analysis. Given a list of changed symbol names or exact " +
      "positions, finds every reference, caller, and test file affected across the workspace. " +
      "Orchestrates lsp_references, lsp_call_hierarchy, and lsp_workspace_symbols across all " +
      "touched symbols and aggregates the results by file.",
    promptSnippet:
      "Analyze the impact of changes to multiple symbols — finds all affected files, " +
      "callers, references, and test files.",
    promptGuidelines: [
      "Use lsp_impact before editing shared or exported modules to understand blast radius.",
      "Pass exact positions ({filePath, line, column}) for the symbols you're changing, " +
        "or pass a bare name string to resolve via workspace symbols first.",
      "For a single symbol, use lsp_references + lsp_call_hierarchy instead — lsp_impact " +
        "is optimized for multi-symbol scenarios.",
      "Call hierarchy is only queried for top-level function/method/constructor symbols. " +
        "Transitive depth follows references, not callers.",
    ],
    parameters: ImpactParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state)
        return failure("lsp_impact", "LSP extension is not initialized.");
      try {
        const cwd = process.cwd();
        const depth = params.depth ?? 1;

        // Resolve symbols (names -> positions via workspace symbols)
        const { resolved, ambiguous } = await resolveSymbols(
          params.symbols,
          state.runtimeManager,
        );

        // Ambiguous names: return candidates for the agent to disambiguate
        if (ambiguous.length > 0) {
          return success(formatAmbiguity(ambiguous), {
            ok: true,
            kind: "impact_ambiguous",
            candidates: ambiguous,
          });
        }

        if (resolved.length === 0) {
          return failure(
            "lsp_impact",
            "None of the specified symbols could be resolved. " +
            "Provide a bare name string, {name} with optional filePath/kind, " +
            "or an exact {filePath, line, column}. " +
            "Bare name resolution depends on the LSP server being indexed. " +
            "If you know the file, use {name, filePath} for faster matching.",
          );
        }

        // Normalize paths to absolute for consistent dedup with LSP URIs
        for (const s of resolved) {
          s.filePath = path.resolve(cwd, s.filePath);
        }

        // Run the impact analysis
        const report = await analyzeImpact(resolved, { depth }, state.runtimeManager);

        // Format and return
        const formatted = formatImpact(report);
        refreshStatus(ctx, state);
        return success(formatted, {
          ok: true,
          kind: "impact_report",
          stats: {
            changed: report.changed.length,
            files: report.affectedFiles.length,
            locations: report.totalLocations,
          },
        });
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_impact", error);
      }
    },
  });

  pi.registerTool<typeof ListWorkspaceRootsParams, unknown>({
    name: "lsp_list_workspace_roots",
    label: "LSP List Workspace Roots",
    description:
      "List all directories currently in LSP workspace scope, along with " +
      "configured LSP servers and their supported file types. " +
      "Includes the project root and any extra workspace roots configured or " +
      "added dynamically via lsp_add_workspace_root.",
    promptSnippet:
      "List LSP workspace roots and configured servers with their file types.",
    promptGuidelines: [
      "Use lsp_list_workspace_roots to discover what LSP servers are configured and which file types each supports. This is the primary tool for assessing your LSP capabilities at runtime.",
      "Use lsp_list_workspace_roots to verify that a directory was added successfully.",
    ],
    parameters: ListWorkspaceRootsParams,
    async execute() {
      const state = getState();
      if (!state)
        return failure(
          "lsp_list_workspace_roots",
          "LSP extension is not initialized.",
        );
      const roots = state.runtimeManager.listWorkspaceRoots();

      // Build server details from catalog
      const servers = state.config.catalog.servers;
      const serverIds = Object.keys(servers);
      const activeClients = state.runtimeManager.activeClients();
      const activeIds = new Set(activeClients.map((c) => c.serverId));

      const serverLines = serverIds.map((id) => {
        const s = servers[id];
        const status = activeIds.has(id) ? "active" : "inactive";
        const fts = s.filetypes.join(", ");
        return `  - ${id}: ${s.displayName} (${fts}) [${status}]`;
      });

      let text = `LSP workspace roots (${roots.length}):\n`;
      text += roots.map((r) => `  - ${r}`).join("\n");
      text += `\n\nConfigured LSP servers (${serverIds.length}):\n`;
      text += serverLines.join("\n");
      return success(text, { roots, servers: serverLines });
    },
  });
}

function refreshStatus(
  ctx: ExtensionContext | undefined,
  state: LspExtensionState,
): void {
  if (ctx) setLspStatusLine(ctx, state);
}
