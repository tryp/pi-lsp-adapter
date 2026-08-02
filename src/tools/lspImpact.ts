import { Type } from "typebox";
import { URI } from "vscode-uri";
import type {
  DocumentSymbol,
  Location,
  SymbolInformation,
  WorkspaceSymbol,
  CallHierarchyIncomingCall,
} from "vscode-languageserver-types";
import type { LspRuntimeManager, LspWorkspaceSymbolsResult } from "../lsp/runtimeManager.js";

// ─── Parameter schema ───────────────────────────────────────────────────

const NameSpec = Type.Object({
  name: Type.String({
    description: "Symbol name to resolve via lsp_workspace_symbols.",
  }),
  filePath: Type.Optional(
    Type.String({ description: "Filter by file when resolving the name." }),
  ),
  kind: Type.Optional(
    Type.String({
      description:
        "Filter by kind when resolving (e.g. 'function', 'class', 'method').",
    }),
  ),
});

const PositionSpec = Type.Object({
  filePath: Type.String({
    description: "Exact file path of the symbol.",
  }),
  line: Type.Integer({
    minimum: 1,
    description:
      "1-based line number. When present with filePath+column, " +
      "skips name resolution and uses exact position.",
  }),
  column: Type.Integer({
    minimum: 1,
    description:
      "1-based column. When present with filePath+line, " +
      "skips name resolution and uses exact position.",
  }),
  name: Type.Optional(
    Type.String({ description: "Optional display name (inferred from file if omitted)." }),
  ),
});

const ImpactParams = Type.Object({
  symbols: Type.Array(
    Type.Union([Type.String(), NameSpec, PositionSpec]),
    {
      minItems: 1,
      maxItems: 50,
      description:
        "Symbols to analyze. Each entry is either:\n" +
        '- A string (symbol name, resolved via workspace symbols)\n' +
        '- {name, filePath?, kind?} — name + optional disambiguation\n' +
        '- {filePath, line, column, name?} — exact position (no resolution needed)',
    },
  ),
  depth: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 3,
      default: 1,
      description:
        "Recursive reference depth. 0=changed symbols only, " +
        "1=include direct references and callers (default), " +
        "2=also include references of those references, " +
        "3=full transitive reference closure. " +
        "Call hierarchy is queried for top-level symbols only.",
    }),
  ),
});

export { ImpactParams };

// ─── Data types ─────────────────────────────────────────────────────────

export interface ResolvedSymbol {
  name: string;
  kind: string;
  filePath: string;
  /** 1-based line */
  line: number;
  /** 1-based column */
  column: number;
  containerName?: string;
}

export interface SymbolRef {
  filePath: string;
  /** 1-based line */
  line: number;
  /** 1-based column */
  column: number;
}

export interface ImpactReport {
  /** Symbols that were input (the "changed" symbols) */
  changed: ResolvedSymbol[];
  /** Per-symbol refs: keyed by `${filePath}:${line}:${col}` */
  refs: Map<string, SymbolRef[]>;
  /** Per-symbol incoming callers */
  callers: Map<string, SymbolRef[]>;
  /** All unique affected files */
  affectedFiles: string[];
  /** Test files among the affected files */
  testFiles: string[];
  /** Total unique reference locations (excluding declarations) */
  totalLocations: number;
  /** Per-file reference counts */
  fileCounts: Map<string, { changed: number; refs: number; isTest: boolean }>;
}

export interface AmbiguousSymbol {
  name: string;
  kind: string;
  filePath: string;
  /** 1-based line */
  line: number;
  /** 1-based column */
  column: number;
  containerName?: string;
}

export interface ResolveResult {
  resolved: ResolvedSymbol[];
  ambiguous: AmbiguousSymbol[];
}

/** Input type after normalization (not a TypeBox schema) */
export type SymbolInput = string | { name: string; filePath?: string; kind?: string } | { filePath: string; line: number; column: number; name?: string };

// ─── Kinds that support call hierarchy ──────────────────────────────────

const CALLABLE_KINDS = new Set([
  "function",
  "method",
  "constructor",
]);

// ─── Test file detection ────────────────────────────────────────────────

export function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes("test_") ||
    lower.includes("_test") ||
    lower.includes(".spec.") ||
    lower.includes("__tests__") ||
    lower.includes("/tests/") ||
    lower.includes("\\tests\\") ||
    lower.endsWith("_test.py") ||
    lower.endsWith("_test.go") ||
    lower.endsWith(".test.ts") ||
    lower.endsWith(".test.tsx") ||
    lower.endsWith(".test.js") ||
    lower.endsWith(".spec.ts") ||
    lower.endsWith(".spec.js")
  );
}

// ─── URI helpers ────────────────────────────────────────────────────────

function uriToFilePath(uri: string): string | null {
  try {
    if (!uri.startsWith("file:")) return null;
    return URI.parse(uri).fsPath;
  } catch {
    return null;
  }
}

// ─── Coordinate helpers ─────────────────────────────────────────────────

/** 1-based to 0-based for LSP protocol calls */
function toLspZero(lineOrCol: number): number {
  return Math.max(0, lineOrCol - 1);
}

/** Convert an LSP Location (0-based) to our 1-based Ref */
function locationToRef(loc: Location): SymbolRef {
  return {
    filePath: uriToFilePath(loc.uri) ?? loc.uri,
    line: loc.range.start.line + 1,
    column: loc.range.start.character + 1,
  };
}

export function symbolKey(s: { filePath: string; line: number; column: number }): string {
  return `${s.filePath}:${s.line}:${s.column}`;
}

// ─── Symbol kind name mapping ───────────────────────────────────────────

const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class",
  6: "method", 7: "property", 8: "field", 9: "constructor", 10: "enum",
  11: "interface", 12: "function", 13: "variable", 14: "constant",
  15: "string", 16: "number", 17: "boolean", 18: "array", 19: "object",
  20: "key", 21: "null", 22: "enumMember", 23: "struct", 24: "event",
  25: "operator", 26: "typeParameter",
};

function symbolKindFromCode(kind: number): string {
  return SYMBOL_KIND_NAMES[kind] ?? "symbol";
}

// ─── Kind resolution for exact positions ────────────────────────────────

interface SymbolInfo {
  name: string;
  kind: string;
}

/**
 * Resolve the real symbol name and kind at a given file+line by looking up
 * document symbols and finding the deepest enclosing symbol.
 */
async function resolveSymbolAtPosition(
  filePath: string,
  line: number,
  runtimeManager: LspRuntimeManager,
): Promise<SymbolInfo> {
  try {
    const dsResult = await runtimeManager.documentSymbols(filePath);
    if (!dsResult.result) return { name: "<unknown>", kind: "symbol" };

    const symbols = dsResult.result;
    if (symbols.length === 0) return { name: "<unknown>", kind: "symbol" };

    // DocumentSymbol[] (has 'children' property) vs SymbolInformation[]
    if ("children" in symbols[0] || "range" in symbols[0]) {
      const found = findSymbolInTree(symbols as DocumentSymbol[], toLspZero(line));
      if (found) return found;
      return { name: "<unknown>", kind: "symbol" };
    }

    // SymbolInformation[] — find by location range
    for (const sym of symbols as SymbolInformation[]) {
      const sl = toLspZero(sym.location.range.start.line);
      const el = toLspZero(sym.location.range.end.line);
      if (sl <= toLspZero(line) && el >= toLspZero(line)) {
        return { name: sym.name, kind: symbolKindFromCode(sym.kind) };
      }
    }

    return { name: "<unknown>", kind: "symbol" };
  } catch {
    return { name: "<unknown>", kind: "symbol" };
  }
}

function findSymbolInTree(
  symbols: DocumentSymbol[],
  zeroLine: number,
): SymbolInfo | null {
  for (const sym of symbols) {
    if (sym.range.start.line <= zeroLine && sym.range.end.line >= zeroLine) {
      // Children are more specific; recurse first
      if (sym.children?.length) {
        const child = findSymbolInTree(sym.children, zeroLine);
        if (child) return child;
      }
      return { name: sym.name, kind: symbolKindFromCode(sym.kind) };
    }
  }
  return null;
}

// ─── Ambiguity formatting ───────────────────────────────────────────────

/**
 * Format resolved symbols into an ambiguity message for the agent.
 */
export function formatAmbiguity(ambiguous: AmbiguousSymbol[]): string {
  const byName = new Map<string, AmbiguousSymbol[]>();
  for (const a of ambiguous) {
    const list = byName.get(a.name) ?? [];
    list.push(a);
    byName.set(a.name, list);
  }

  let msg =
    `lsp_impact: ambiguous symbol${ambiguous.length > 1 ? "s" : ""}\n\n` +
    `The following symbol${ambiguous.length > 1 ? "s" : ""} matched multiple workspace symbols:\n\n`;

  for (const [name, candidates] of byName) {
    msg += `  "${name}" — ${candidates.length} matches:\n`;
    const shown = candidates.slice(0, 8);
    for (const c of shown) {
      const container = c.containerName ? ` [${c.containerName}]` : "";
      msg += `    ${c.filePath}:${c.line}:${c.column}  \`${c.name}\` (${c.kind})${container}\n`;
    }
    if (candidates.length > 8) {
      msg += `    ... ${candidates.length - 8} more\n`;
    }
  }

  msg += `\nCall lsp_impact again with an exact position ` +
    `({filePath, line, column}) to disambiguate.`;
  return msg;
}

// ─── Symbol resolution ──────────────────────────────────────────────────

export async function resolveSymbols(
  specs: SymbolInput[],
  runtimeManager: LspRuntimeManager,
): Promise<ResolveResult> {
  const resolved: ResolvedSymbol[] = [];
  const ambiguous: AmbiguousSymbol[] = [];

  for (const spec of specs) {
    if (typeof spec === "string") {
      // Case 1: bare name — resolve via workspace symbols
      await resolveByName(spec, undefined, runtimeManager, resolved, ambiguous);
    } else if ("line" in spec && "column" in spec) {
      // Case 2: exact position — skip name resolution, look up real name+kind
      const info = await resolveSymbolAtPosition(spec.filePath, spec.line, runtimeManager);
      resolved.push({
        name: spec.name ?? info.name,
        kind: info.kind,
        filePath: spec.filePath,
        line: spec.line,
        column: spec.column,
      });
    } else {
      // Case 3: name + optional disambiguation
      await resolveByName(
        spec.name,
        { filePath: spec.filePath, kind: spec.kind },
        runtimeManager,
        resolved,
        ambiguous,
      );
    }
  }

  return { resolved, ambiguous };
}

/** Server IDs known to support workspace symbols, ordered by likelihood. */
const FALLBACK_SERVERS = [
  "vtsls",      // TS/JS
  "pyright",    // Python
  "rust-analyzer", // Rust
  "gopls",      // Go
  "clangd",     // C/C++
  "jdtls",      // Java
];

async function resolveByName(
  name: string,
  filters: { filePath?: string; kind?: string } | undefined,
  runtimeManager: LspRuntimeManager,
  resolved: ResolvedSymbol[],
  ambiguous: AmbiguousSymbol[],
): Promise<void> {
  // First try: query already-active clients only (fast, no server startup)
  let wsResults = await runtimeManager.workspaceSymbols(name);
  let candidates = flattenWorkspaceResults(wsResults);

  // Fallback: no active servers returned results. Try starting known
  // workspace-symbol-capable servers one at a time. This is a one-time
  // latency cost while the server starts and gets cached.
  if (candidates.length === 0) {
    for (const serverId of FALLBACK_SERVERS) {
      try {
        wsResults = await runtimeManager.workspaceSymbols(name, serverId);
        candidates = flattenWorkspaceResults(wsResults);
        if (candidates.length > 0) break;
      } catch {
        // server not configured or installed — skip
      }
    }
  }

  if (filters?.kind) {
    const kinds = filters.kind.toLowerCase().split(/,\s*/);
    candidates = candidates.filter((c) => kinds.includes(c.kind.toLowerCase()));
  }
  if (filters?.filePath) {
    candidates = candidates.filter((c) => c.filePath === filters.filePath);
  }

  if (candidates.length === 0) return;

  if (candidates.length === 1) {
    resolved.push(candidates[0]);
    return;
  }

  // Multiple matches — always report as ambiguous
  ambiguous.push(...candidates);
}

function flattenWorkspaceResults(
  results: LspWorkspaceSymbolsResult[],
): ResolvedSymbol[] {
  const out: ResolvedSymbol[] = [];
  for (const entry of results) {
    if (!entry.result) continue;
    for (const sym of entry.result) {
      const loc = normalizeWorkspaceSymbolLocation(sym);
      if (!loc) continue;
      out.push({
        name: sym.name,
        kind: symbolKindFromCode(sym.kind),
        filePath: loc.filePath,
        line: loc.line,
        column: loc.column,
        containerName: "containerName" in sym ? (sym as SymbolInformation).containerName : undefined,
      });
    }
  }
  return out;
}

interface NormalizedLocation {
  filePath: string;
  line: number;
  column: number;
}

function normalizeWorkspaceSymbolLocation(
  sym: SymbolInformation | WorkspaceSymbol,
): NormalizedLocation | null {
  try {
    const raw: unknown =
      "location" in sym ? (sym as SymbolInformation).location :
      (sym as WorkspaceSymbol).location ?? null;
    const location = raw as { uri: string; range?: { start: { line: number; character: number } } } | null;
    if (!location) return null;

    const fp = uriToFilePath(location.uri);
    if (!fp) return null;

    if (location.range) {
      return {
        filePath: fp,
        line: location.range.start.line + 1,
        column: location.range.start.character + 1,
      };
    }

    return { filePath: fp, line: 1, column: 1 };
  } catch {
    return null;
  }
}

// ─── Impact analysis ────────────────────────────────────────────────────

/**
 * Run impact analysis on resolved symbols.
 *
 * For each top-level symbol:
 * - Query references (all usages)
 * - If callable (function/method/constructor), query incoming call hierarchy
 *
 * With depth > 1, recursively follow references (but not callers) to find
 * transitive impact. Call hierarchy is only queried for top-level symbols.
 */
export async function analyzeImpact(
  symbols: ResolvedSymbol[],
  options: { depth: number; maxReferences?: number },
  runtimeManager: LspRuntimeManager,
): Promise<ImpactReport> {
  const maxRefs = options.maxReferences ?? 100;
  const refs = new Map<string, SymbolRef[]>();
  const callers = new Map<string, SymbolRef[]>();
  const fileRefCounts = new Map<string, number>();
  const visited = new Set<string>();

  // Seed visited with the input symbols
  for (const s of symbols) visited.add(symbolKey(s));

  let currentLevel: ResolvedSymbol[] = symbols;
  let remainingDepth = options.depth;
  const batchSize = 10;

  while (remainingDepth >= 0 && currentLevel.length > 0) {
    const nextLevel: ResolvedSymbol[] = [];
    const isTopLevel = remainingDepth === options.depth;

    for (let i = 0; i < currentLevel.length; i += batchSize) {
      const batch = currentLevel.slice(i, i + batchSize);
      await Promise.allSettled(
        batch.map(async (sym) => {
          const skey = symbolKey(sym);
          const lspline = toLspZero(sym.line);
          const lspcol = toLspZero(sym.column);

          // --- References ---
          let symRefs: SymbolRef[] = [];
          try {
            const refResult = await runtimeManager.references(
              sym.filePath,
              lspline,
              lspcol,
              false,
            );
            if (refResult.result) {
              symRefs = refResult.result
                .map(locationToRef)
                .filter((r) => symbolKey(r) !== skey)
                .slice(0, maxRefs);
            }
          } catch {
            // non-fatal: some servers don't support references for certain files
          }
          refs.set(skey, symRefs);
          for (const r of symRefs) {
            fileRefCounts.set(r.filePath, (fileRefCounts.get(r.filePath) ?? 0) + 1);
          }

          // --- Call hierarchy (top-level callable symbols only) ---
          let symCallers: SymbolRef[] = [];
          if (isTopLevel && CALLABLE_KINDS.has(sym.kind.toLowerCase())) {
            try {
              const chResult = await runtimeManager.callHierarchy(
                sym.filePath,
                lspline,
                lspcol,
                "incoming",
              );
              if (chResult.result) {
                symCallers = (chResult.result as CallHierarchyIncomingCall[])
                  .flatMap((call) =>
                    call.fromRanges.map((r) => ({
                      filePath: uriToFilePath(call.from.uri) ?? call.from.uri,
                      line: r.start.line + 1,
                      column: r.start.character + 1,
                    })),
                  )
                  .filter((r) => symbolKey(r) !== skey)
                  .slice(0, maxRefs);
              }
            } catch {
              // non-fatal
            }
          }
          callers.set(skey, symCallers);
          for (const c of symCallers) {
            fileRefCounts.set(c.filePath, (fileRefCounts.get(c.filePath) ?? 0) + 1);
          }

          // For transitive depth, collect next-level reference positions
          if (remainingDepth > 0 && symRefs.length > 0) {
            for (const loc of symRefs) {
              const lkey = symbolKey(loc);
              if (!visited.has(lkey)) {
                visited.add(lkey);
                nextLevel.push({
                  name: "<transitive>",
                  kind: "symbol",
                  filePath: loc.filePath,
                  line: loc.line,
                  column: loc.column,
                });
              }
            }
          }
        }),
      );
    }

    currentLevel = nextLevel;
    remainingDepth--;
  }

  // Collect all affected files
  const allFiles = new Set<string>();
  for (const s of symbols) allFiles.add(s.filePath);
  for (const [, locs] of refs) for (const l of locs) allFiles.add(l.filePath);
  for (const [, locs] of callers) for (const l of locs) allFiles.add(l.filePath);

  const affectedFiles = [...allFiles].sort();
  const testFiles = affectedFiles.filter(isTestFile);

  // Unique reference locations
  const uniqueLocs = new Set<string>();
  for (const [, locs] of refs) for (const l of locs) uniqueLocs.add(symbolKey(l));
  for (const [, locs] of callers) for (const l of locs) uniqueLocs.add(symbolKey(l));

  // Per-file stats
  const fileCounts = new Map<string, { changed: number; refs: number; isTest: boolean }>();
  for (const f of affectedFiles) {
    const changed = symbols.filter((s) => s.filePath === f).length;
    const rf = fileRefCounts.get(f) ?? 0;
    fileCounts.set(f, { changed, refs: rf, isTest: isTestFile(f) });
  }

  return {
    changed: symbols,
    refs,
    callers,
    affectedFiles,
    testFiles,
    totalLocations: uniqueLocs.size,
    fileCounts,
  };
}
