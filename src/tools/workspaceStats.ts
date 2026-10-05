import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OutsideWorkspaceRefusal } from "../lsp/runtimeManager.js";

/**
 * Counters for outside-workspace refusals.
 *
 * AGENTS.md: every silent path needs a counter. The guard is silent by
 * construction -- the agent sees one failed tool call and usually stops using
 * LSP for the rest of the session -- so without this the only way to notice the
 * loss is to grep session logs for the error string, which is how the 44/0
 * refusal/recovery ratio in the commit message was found in the first place.
 *
 * `repeats` is the interesting one: a repeat means the same path was refused
 * after the first refusal had already named the fix, so the hint is not being
 * read.
 */
interface WorkspaceScopeStats {
  /** Refusals from an explicit LSP tool call. */
  toolRefusals: number;
  /** Refusals from the background start triggered by a plain `read`. */
  warmupRefusals: number;
  /** Refusals from the pre-edit auto-diag baseline lookup. */
  baselineRefusals: number;
  /** Refusals for a path already refused earlier in this session. */
  repeats: number;
  /** Distinct paths refused. */
  distinctPaths: number;
  /** Hits per path, for the top offenders. */
  pathHits: Map<string, number>;
  /** Directory we most recently suggested adding. */
  lastSuggestedRoot?: string;
}

function emptyStats(): WorkspaceScopeStats {
  return {
    toolRefusals: 0,
    warmupRefusals: 0,
    baselineRefusals: 0,
    repeats: 0,
    distinctPaths: 0,
    pathHits: new Map(),
  };
}

let stats = emptyStats();

/**
 * Refusals recorded since the last persisted snapshot.
 *
 * Persisted next to the cumulative totals: an entry written every 5 refusals
 * would otherwise have to be read as "latest wins", and a consumer summing
 * entries would multiply the count by the number of flushes.
 */
let batch = emptyStats();

/** Persist every N refusals, so a killed session still leaves usable evidence. */
const FLUSH_EVERY = 5;

/** How many offending paths to persist. Full lists make the entry unreadable. */
const TOP_PATHS = 5;

let activePi: ExtensionAPI | null = null;

/**
 * Wire the counters to session lifecycle events.
 *
 * Session-scoped, not process-scoped: the counters live in module state, so a
 * `/new` or `/resume` has to zero them or the previous session's refusals would
 * be reported against the new one.
 */
export function registerWorkspaceScopeStats(pi: ExtensionAPI): void {
  activePi = pi;
  pi.on("session_start", () => {
    resetWorkspaceScopeStats();
  });
  pi.on("session_shutdown", () => {
    flushWorkspaceScopeStats();
  });
}

/** Record one refusal and flush on cadence. */
export function recordOutsideWorkspaceRefusal(refusal: OutsideWorkspaceRefusal): void {
  const previous = stats.pathHits.get(refusal.filePath) ?? 0;
  if (previous > 0) {
    stats.repeats += 1;
    batch.repeats += 1;
  }
  stats.pathHits.set(refusal.filePath, previous + 1);
  // First sighting of this path, not "the map has one entry": the latter only
  // ever counts once, which made distinctPaths report 1 for any session.
  if (previous === 0) {
    stats.distinctPaths += 1;
    batch.distinctPaths += 1;
  }
  switch (refusal.reason) {
    case "warmup":
      stats.warmupRefusals += 1;
      batch.warmupRefusals += 1;
      break;
    case "auto-diag-baseline":
      stats.baselineRefusals += 1;
      batch.baselineRefusals += 1;
      break;
    default:
      stats.toolRefusals += 1;
      batch.toolRefusals += 1;
      break;
  }
  stats.lastSuggestedRoot = refusal.suggestedRoot;

  if (countRefusals(batch) >= FLUSH_EVERY) flushWorkspaceScopeStats();
}

function countRefusals(state: WorkspaceScopeStats): number {
  return state.toolRefusals + state.warmupRefusals + state.baselineRefusals;
}

/**
 * Write a snapshot to the session file.
 *
 * appendEntry is synchronous file I/O and can throw (EACCES, ENOSPC, a closed
 * session file). A counter that breaks the caller is worse than a counter that
 * misses a batch, so failures are swallowed and the batch stays pending for the
 * next flush. The cumulative totals are unaffected either way.
 */
export function flushWorkspaceScopeStats(): void {
  if (!activePi || countRefusals(batch) === 0) return;
  const pathHits = [...stats.pathHits.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_PATHS)
    .map(([path, hits]) => ({ path, hits }));
  try {
    activePi.appendEntry("lsp_workspace_scope", {
      cumulative: {
        toolRefusals: stats.toolRefusals,
        warmupRefusals: stats.warmupRefusals,
        baselineRefusals: stats.baselineRefusals,
        repeats: stats.repeats,
        distinctPaths: stats.distinctPaths,
      },
      sinceLastEntry: {
        toolRefusals: batch.toolRefusals,
        warmupRefusals: batch.warmupRefusals,
        baselineRefusals: batch.baselineRefusals,
        repeats: batch.repeats,
        distinctPaths: batch.distinctPaths,
      },
      lastSuggestedRoot: stats.lastSuggestedRoot,
      topPaths: pathHits,
    });
  } catch {
    // Keep the batch pending; the next refusal or shutdown flush retries it.
    return;
  }
  batch = emptyStats();
}

/** Zero the counters. Called at session start. */
export function resetWorkspaceScopeStats(): void {
  stats = emptyStats();
  batch = emptyStats();
}

/** Current cumulative counters, for `/lsp status` and tests. */
export function getWorkspaceScopeStats(): {
  toolRefusals: number;
  warmupRefusals: number;
  baselineRefusals: number;
  repeats: number;
  distinctPaths: number;
  lastSuggestedRoot?: string;
} {
  return {
    toolRefusals: stats.toolRefusals,
    warmupRefusals: stats.warmupRefusals,
    baselineRefusals: stats.baselineRefusals,
    repeats: stats.repeats,
    distinctPaths: stats.distinctPaths,
    lastSuggestedRoot: stats.lastSuggestedRoot,
  };
}
