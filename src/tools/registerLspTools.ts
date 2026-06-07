import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LspExtensionState } from "../state.js";
import { setLspStatusLine } from "../statusLine.js";
import {
  failure,
  formatCallHierarchy,
  formatCodeActions,
  formatDefinition,
  formatDiagnostics,
  formatDocumentSymbols,
  formatHover,
  formatImplementations,
  formatReferences,
  formatRenameEdit,
  formatTypeDefinition,
  formatWorkspaceSymbols,
  toLspPosition,
} from "./lspFormat.js";
import { LSP_RESULT_ID_LENGTH, LSP_RESULT_ID_PATTERN } from "./resultCache.js";

export type GetLspToolState = () => LspExtensionState | null;

const FilePathParams = Type.Object({
  filePath: Type.String({ description: "Path to the source file to inspect." }),
});

const FilePositionParams = Type.Object({
  filePath: Type.String({ description: "Path to the source file to inspect." }),
  line: Type.Integer({ minimum: 1, description: "1-based line number." }),
  column: Type.Integer({
    minimum: 1,
    description: "1-based column/character number. For symbol queries, place it on the identifier token.",
  }),
});

const ReferencesParams = Type.Object({
  filePath: Type.String({ description: "Path to the source file to inspect." }),
  line: Type.Integer({ minimum: 1, description: "1-based line number." }),
  column: Type.Integer({
    minimum: 1,
    description: "1-based column/character number. For symbol queries, place it on the identifier token.",
  }),
  includeDeclaration: Type.Optional(
    Type.Boolean({ description: "Whether to include the symbol declaration in the result." }),
  ),
});

const WorkspaceSymbolsParams = Type.Object({
  query: Type.String({ description: "Workspace symbol query string." }),
  serverId: Type.Optional(Type.String({ description: "Optional LSP server id to query, e.g. pyright or vtsls." })),
});

const MoreParams = Type.Object({
  resultId: Type.String({
    description: "Exact cached LSP resultId returned by a previous paginated LSP tool result.",
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
    description: "1-based column/character number. Place it on the identifier or error token.",
  }),
});

const CallHierarchyParams = Type.Object({
  filePath: Type.String({ description: "Path to the source file to inspect." }),
  line: Type.Integer({ minimum: 1, description: "1-based line number." }),
  column: Type.Integer({
    minimum: 1,
    description: "1-based column/character number. Place it on the identifier token.",
  }),
  direction: Type.String({ description: "Direction of call hierarchy: 'incoming' or 'outgoing'." }),
});

const RenameParams = Type.Object({
  filePath: Type.String({ description: "Path to the source file to inspect." }),
  line: Type.Integer({ minimum: 1, description: "1-based line number of the symbol to rename." }),
  column: Type.Integer({
    minimum: 1,
    description: "1-based column/character number. Place it on the symbol identifier to rename.",
  }),
  newName: Type.String({ description: "The new name for the symbol." }),
});

export function registerLspTools(pi: ExtensionAPI, getState: GetLspToolState): void {
  pi.registerTool<typeof FilePathParams, unknown>({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Read diagnostics for a file using its configured language server. Compact output — only severity/source/code/line:col per issue, no file content transferred.",
    promptSnippet: "Inspect compiler/type/lint diagnostics from configured language servers for a file.",
    promptGuidelines: [
      "Use lsp_diagnostics after reading or editing code when semantic errors, type errors, or language-server diagnostics would help.",
      "Returns only filepath/line/column of issues — no file content transferred. More compact than scanning the file manually.",
    ],
    parameters: FilePathParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state) return failure("lsp_diagnostics", "LSP extension is not initialized.");
      try {
        const result = formatDiagnostics(await state.runtimeManager.diagnostics(params.filePath), state.resultCache);
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
    description: "Get hover/type information at a source position. line and column are 1-based.",
    promptSnippet: "Fetch hover/type information for a symbol at a 1-based line and column.",
    promptGuidelines: [
      "Use lsp_hover when symbol type, signature, documentation, or inferred information would reduce guesswork. Put line/column on the identifier token itself, not whitespace or surrounding syntax.",
      "Returns only the type signature and docs for the symbol at that position — compact and focused, unlike reading the surrounding code block.",
    ],
    parameters: FilePositionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state) return failure("lsp_hover", "LSP extension is not initialized.");
      try {
        const position = toLspPosition(params);
        const result = formatHover(
          await state.runtimeManager.hover(params.filePath, position.line, position.character),
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
    description: "Find definition locations for the symbol at a source position. line and column are 1-based.",
    promptSnippet: "Jump to definitions for a symbol at a 1-based line and column.",
    promptGuidelines: [
      "Use lsp_definition before changing unfamiliar call sites, types, or imported symbols. Put line/column on the identifier token itself, not an import path string or surrounding syntax.",
      "Returns file:line:column targets only — does not transfer file content.",
    ],
    parameters: FilePositionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state) return failure("lsp_definition", "LSP extension is not initialized.");
      try {
        const position = toLspPosition(params);
        const result = formatDefinition(
          await state.runtimeManager.definition(params.filePath, position.line, position.character),
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
    description: "Find references for the symbol at a source position. line and column are 1-based.",
    promptSnippet: "Find references for a symbol at a 1-based line and column.",
    promptGuidelines: [
      "Use lsp_references to assess impact before renames, API changes, or behavior changes. Put line/column on the identifier token itself; set includeDeclaration when you need the declaration included in the results.",
      "Returns all reference locations across the workspace as file:line:column — no file content transferred.",
    ],
    parameters: ReferencesParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state) return failure("lsp_references", "LSP extension is not initialized.");
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
    description: "List symbols in a source file using its configured language server. Only needs filePath — no line/col required.",
    promptSnippet: "List functions, classes, variables, and other symbols in a source file.",
    promptGuidelines: [
      "Use lsp_document_symbols INSTEAD OF reading L1-60 to understand a file's structure. Returns a tree of all functions, classes, and variables with line numbers — no file content transferred. Only needs filePath (no line/col required).",
      "After lsp_document_symbols, follow up with lsp_hover on specific lines to inspect individual function signatures instead of re-reading the file.",
    ],
    parameters: FilePathParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state) return failure("lsp_document_symbols", "LSP extension is not initialized.");
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
      "Search symbols across active LSP workspaces. Optionally provide a server id to start/query that server for the current cwd.",
    promptSnippet: "Search workspace symbols by name across active language-server sessions.",
    promptGuidelines: [
      "Use lsp_workspace_symbols to locate definitions or related symbols by name when file paths are unknown. Omit serverId to query active servers only; provide a configured serverId, such as vtsls or pyright, when you want to start/query a specific server for the current cwd.",
      "Returns matching symbols with file:line locations — no file content scanned. More efficient than grep for named symbols.",
    ],
    parameters: WorkspaceSymbolsParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state) return failure("lsp_workspace_symbols", "LSP extension is not initialized.");
      try {
        const result = formatWorkspaceSymbols(
          await state.runtimeManager.workspaceSymbols(params.query, params.serverId),
          state.resultCache,
          { query: params.query },
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
    description: "Return the next cached page from a previous paginated LSP result.",
    promptSnippet:
      "Fetch the next sequential page for a previous LSP resultId without re-querying the language server.",
    promptGuidelines: [
      "Use lsp_more only when the previous LSP result explicitly says 'More available' and provides a resultId. Cached pages are sequential and may expire after cache eviction or session restart; if a resultId is missing or expired, re-run the original LSP query.",
    ],
    parameters: MoreParams,
    async execute(_toolCallId, params) {
      const state = getState();
      if (!state) return failure("lsp_more", "LSP extension is not initialized.");
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
      "Returns a list of available actions with their kinds and whether they're preferred. Each action shows its title, kind, and any associated diagnostics it addresses.",
    ],
    parameters: CodeActionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state) return failure("lsp_code_action", "LSP extension is not initialized.");
      try {
        const position = toLspPosition(params);
        const result = formatCodeActions(
          await state.runtimeManager.codeAction(params.filePath, position.line, position.character),
          state.resultCache,
        );
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
      if (!state) return failure("lsp_rename", "LSP extension is not initialized.");
      try {
        const position = toLspPosition(params);
        const result = formatRenameEdit(
          await state.runtimeManager.rename(params.filePath, position.line, position.character, params.newName),
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
      if (!state) return failure("lsp_implementation", "LSP extension is not initialized.");
      try {
        const position = toLspPosition(params);
        const result = formatImplementations(
          await state.runtimeManager.implementation(params.filePath, position.line, position.character),
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
      if (!state) return failure("lsp_type_definition", "LSP extension is not initialized.");
      try {
        const position = toLspPosition(params);
        const result = formatTypeDefinition(
          await state.runtimeManager.typeDefinition(params.filePath, position.line, position.character),
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
      if (!state) return failure("lsp_call_hierarchy", "LSP extension is not initialized.");
      try {
        const position = toLspPosition(params);
        const result = formatCallHierarchy(
          await state.runtimeManager.callHierarchy(params.filePath, position.line, position.character, params.direction),
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
}

function refreshStatus(ctx: ExtensionContext | undefined, state: LspExtensionState): void {
  if (ctx) setLspStatusLine(ctx, state);
}
