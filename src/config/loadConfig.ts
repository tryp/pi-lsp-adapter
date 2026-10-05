import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isNodeError, isPlainObject, isPythonServerId, messageFromError } from "../util/helpers.js";
import { BUILTIN_CATALOG } from "../registry/builtin.js";
import { parseServerDefinition } from "../registry/schema.js";
import type { AutoWorkspaceRootMode, Catalog, InstallMode, ServerDefinition } from "../registry/schema.js";
import { deepClone, deepMerge } from "../util/deepMerge.js";
import { getProjectConfigPath, getUserConfigPath } from "./paths.js";
import { isProjectTrusted } from "./trust.js";

export interface LoadLspConfigInput {
  cwd: string;
  projectRoot?: string;
}

export interface LoadLspConfigResult {
  catalog: Catalog;
  warnings: string[];
  installMode: InstallMode;
  warmup: boolean;
  extraWorkspaceRoots: string[];
  autoWorkspaceRoots: string[];
  autoWorkspaceRootMode: AutoWorkspaceRootMode;
}

/**
 * Trees treated as the user's own when auto-adding an out-of-scope project.
 *
 * Resolved per call rather than at module load, so a HOME change (tests, and
 * anyone running pi against a different home) is honored. Deliberately narrow:
 * these are directories the user creates worktrees and repositories in, not
 * temp directories or anything that arrived from outside.
 */
export function defaultAutoWorkspaceRoots(): string[] {
  return [join(homedir(), "src"), join(homedir(), ".pi", "worktree-checkouts")];
}

interface RawLspConfig {
  installMode?: unknown;
  warmup?: unknown;
  servers?: unknown;
  extraWorkspaceRoots?: unknown;
  autoWorkspaceRoots?: unknown;
  autoWorkspaceRootMode?: unknown;
}

interface ConfigSource {
  label: string;
  path: string;
  kind: "global" | "project";
  trustedProjectOverrides: boolean;
}

const INSTALL_MODES = new Set<InstallMode>(["prompt", "auto", "off"]);
const AUTO_ROOT_MODES = new Set<AutoWorkspaceRootMode>(["trusted", "all", "off"]);
const SAFE_PROJECT_SERVER_FIELDS = new Set([
  "filetypes",
  "rootMarkers",
  "settings",
  "initializationOptions",
  "env",
  "cwd",
  // A wait bound is a latency budget, not a privilege: a trusted project may
  // raise it for a slow server. It cannot execute anything.
  "diagnosticsWaitMs",
]);

const DANGEROUS_PROJECT_ENV_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "CLASSPATH",
]);
const DANGEROUS_PROJECT_ENV_PREFIXES = ["DYLD_", "NPM_CONFIG_", "YARN_", "PNPM_"];

export async function loadLspConfig(input: LoadLspConfigInput): Promise<LoadLspConfigResult> {
  const warnings: string[] = [];
  const catalog = deepClone(BUILTIN_CATALOG);
  let installMode: InstallMode = "prompt";
  let warmup = true;
  let extraWorkspaceRoots: string[] = [];
  let autoWorkspaceRoots: string[] = defaultAutoWorkspaceRoots();
  let autoWorkspaceRootMode: AutoWorkspaceRootMode = "trusted";
  const projectRoot = input.projectRoot ?? input.cwd;
  const projectTrusted = await isProjectTrusted(projectRoot);

  const sources: ConfigSource[] = [
    {
      label: "global config",
      path: getUserConfigPath(),
      kind: "global",
      trustedProjectOverrides: true,
    },
    {
      label: "project config",
      path: getProjectConfigPath(projectRoot),
      kind: "project",
      trustedProjectOverrides: projectTrusted,
    },
  ];

  for (const source of sources) {
    const config = await readConfig(source, warnings);
    if (!config) continue;

    installMode = mergeInstallMode(installMode, config.installMode, source, projectRoot, warnings);
    warmup = mergeWarmup(warmup, config.warmup, source, projectRoot, warnings);
    extraWorkspaceRoots = mergeExtraWorkspaceRoots(
      extraWorkspaceRoots,
      config.extraWorkspaceRoots,
      source,
      projectRoot,
      warnings,
    );
    autoWorkspaceRoots = mergeAutoWorkspaceRoots(
      autoWorkspaceRoots,
      config.autoWorkspaceRoots,
      source,
      projectRoot,
      warnings,
    );
    autoWorkspaceRootMode = mergeAutoWorkspaceRootMode(
      autoWorkspaceRootMode,
      config.autoWorkspaceRootMode,
      source,
      projectRoot,
      warnings,
    );
    mergeServers(catalog, config.servers, source, projectRoot, warnings);
  }

  return {
    catalog,
    warnings,
    installMode,
    warmup,
    extraWorkspaceRoots,
    autoWorkspaceRoots,
    autoWorkspaceRootMode,
  };
}

async function readConfig(source: ConfigSource, warnings: string[]): Promise<RawLspConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(source.path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    warnings.push(`Could not read ${source.label} at ${source.path}: ${messageFromError(error)}`);
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warnings.push(`Could not parse ${source.label} at ${source.path}: ${messageFromError(error)}`);
    return undefined;
  }

  if (!isPlainObject(parsed)) {
    warnings.push(`Ignoring ${source.label} at ${source.path}: top-level value must be an object.`);
    return undefined;
  }

  return parsed;
}

function mergeInstallMode(
  current: InstallMode,
  value: unknown,
  source: ConfigSource,
  projectRoot: string,
  warnings: string[],
): InstallMode {
  if (value === undefined) return current;

  if (source.kind === "project" && !source.trustedProjectOverrides) {
    warnings.push(
      `Ignoring trusted-only project installMode from ${source.path}; run /lsp trust ${projectRoot} to allow project installMode overrides.`,
    );
    return current;
  }

  if (typeof value === "string" && INSTALL_MODES.has(value as InstallMode)) {
    return value as InstallMode;
  }

  warnings.push(`Ignoring invalid installMode in ${source.label} at ${source.path}: expected prompt, auto, or off.`);
  return current;
}

function mergeWarmup(
  current: boolean,
  value: unknown,
  source: ConfigSource,
  projectRoot: string,
  warnings: string[],
): boolean {
  if (value === undefined) return current;

  if (source.kind === "project" && !source.trustedProjectOverrides) {
    warnings.push(
      `Ignoring trusted-only project warmup from ${source.path}; run /lsp trust ${projectRoot} to allow project warmup overrides.`,
    );
    return current;
  }

  if (typeof value === "boolean") {
    return value;
  }

  warnings.push(`Ignoring invalid warmup in ${source.label} at ${source.path}: expected true or false.`);
  return current;
}

function mergeExtraWorkspaceRoots(
  current: string[],
  value: unknown,
  source: ConfigSource,
  _projectRoot: string,
  warnings: string[],
): string[] {
  if (value === undefined) return current;

  if (!Array.isArray(value)) {
    warnings.push(
      `Ignoring invalid extraWorkspaceRoots in ${source.label} at ${source.path}: expected an array of strings.`,
    );
    return current;
  }

  const resolved: string[] = [...current];
  for (const entry of value) {
    if (typeof entry !== "string") {
      warnings.push(
        `Ignoring invalid extraWorkspaceRoot entry in ${source.label} at ${source.path}: each entry must be a string.`,
      );
      continue;
    }
    resolved.push(entry);
  }

  return resolved;
}

/**
 * Expand a leading `~` so config files stay machine-independent.
 *
 * `resolve()` alone would treat "~/src" as a directory literally named "~",
 * which never exists, and the setting would silently do nothing.
 */
export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

function mergeAutoWorkspaceRoots(
  current: string[],
  value: unknown,
  source: ConfigSource,
  projectRoot: string,
  warnings: string[],
): string[] {
  if (value === undefined) return current;
  // These two settings decide what the extension may reach without asking.
  // A checkout the session owner has not trusted must not be able to widen
  // that, exactly as it cannot enable warmup or add servers.
  if (source.kind === "project" && !source.trustedProjectOverrides) {
    warnings.push(
      `Ignoring trusted-only project autoWorkspaceRoots from ${source.path}; run /lsp trust ${projectRoot} to allow them.`,
    );
    return current;
  }
  if (!Array.isArray(value)) {
    warnings.push(
      `Ignoring invalid autoWorkspaceRoots in ${source.label} at ${source.path}: expected an array of strings.`,
    );
    return current;
  }
  const resolved = [...current];
  for (const entry of value) {
    if (typeof entry !== "string") {
      warnings.push(
        `Ignoring invalid autoWorkspaceRoots entry in ${source.label} at ${source.path}: each entry must be a string.`,
      );
      continue;
    }
    resolved.push(resolve(expandHome(entry)));
  }
  return resolved;
}

function mergeAutoWorkspaceRootMode(
  current: AutoWorkspaceRootMode,
  value: unknown,
  source: ConfigSource,
  projectRoot: string,
  warnings: string[],
): AutoWorkspaceRootMode {
  if (value === undefined) return current;
  if (source.kind === "project" && !source.trustedProjectOverrides) {
    warnings.push(
      `Ignoring trusted-only project autoWorkspaceRootMode from ${source.path}; run /lsp trust ${projectRoot} to allow it.`,
    );
    return current;
  }
  if (typeof value !== "string" || !AUTO_ROOT_MODES.has(value as AutoWorkspaceRootMode)) {
    warnings.push(
      `Ignoring invalid autoWorkspaceRootMode in ${source.label} at ${source.path}: expected one of ${[...AUTO_ROOT_MODES].join(", ")}.`,
    );
    return current;
  }
  return value as AutoWorkspaceRootMode;
}

function mergeServers(
  catalog: Catalog,
  servers: unknown,
  source: ConfigSource,
  projectRoot: string,
  warnings: string[],
): void {
  if (servers === undefined) return;
  if (!isPlainObject(servers)) {
    warnings.push(`Ignoring servers in ${source.label} at ${source.path}: expected an object.`);
    return;
  }

  for (const [serverId, rawOverride] of Object.entries(servers)) {
    if (!isPlainObject(rawOverride)) {
      warnings.push(`Ignoring ${serverId} in ${source.label} at ${source.path}: server override must be an object.`);
      continue;
    }

    const override =
      source.kind === "project" && !source.trustedProjectOverrides
        ? filterUntrustedProjectServerFields(serverId, rawOverride, source, projectRoot, warnings)
        : rawOverride;

    const base = catalog.servers[serverId];
    const merged = enforceCatalogKeyId(
      mergeServerDefinition(base, serverId, override),
      serverId,
      override,
      source,
      warnings,
    );
    const parsed = parseServerDefinition(merged);
    if (!parsed.ok) {
      warnings.push(
        `Ignoring invalid ${serverId} server definition from ${source.label} at ${source.path}: ${parsed.errors.join("; ")}.`,
      );
      continue;
    }

    catalog.servers[serverId] = parsed.value;
  }
}

function mergeServerDefinition(
  base: ServerDefinition | undefined,
  serverId: string,
  override: Record<string, unknown>,
): unknown {
  const baseForMerge = deepClone((base ?? { id: serverId }) as unknown as Record<string, unknown>);

  if (
    base &&
    isPlainObject(baseForMerge) &&
    isPlainObject(baseForMerge.install) &&
    isPlainObject(override.install) &&
    typeof override.install.type === "string" &&
    override.install.type !== base.install.type
  ) {
    baseForMerge.install = {};
  }

  return normalizeServerDefinitionShorthand(deepMerge(baseForMerge, override), override);
}

function normalizeServerDefinitionShorthand(merged: unknown, override: Record<string, unknown>): unknown {
  if (!isPlainObject(merged)) return merged;

  if (isPlainObject(merged.install) && merged.install.type === "system") {
    if (merged.command === undefined && Array.isArray(merged.install.command)) {
      return { ...merged, command: deepClone(merged.install.command) };
    }

    if (override.command === undefined && Array.isArray(merged.install.command)) {
      return { ...merged, command: deepClone(merged.install.command) };
    }
  }

  return merged;
}

function filterUntrustedProjectServerFields(
  serverId: string,
  override: Record<string, unknown>,
  source: ConfigSource,
  projectRoot: string,
  warnings: string[],
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(override)) {
    if (!SAFE_PROJECT_SERVER_FIELDS.has(key)) {
      warnings.push(ignoredProjectServerFieldWarning(serverId, key, source.path, projectRoot));
      continue;
    }

    if (key === "env") {
      const sanitizedEnv = filterUntrustedProjectEnv(serverId, value, source.path, warnings);
      if (sanitizedEnv !== undefined) filtered.env = sanitizedEnv;
      continue;
    }

    if (key === "cwd") {
      const sanitizedCwd = filterUntrustedProjectCwd(serverId, value, source.path, projectRoot, warnings);
      if (sanitizedCwd !== undefined) filtered.cwd = sanitizedCwd;
      continue;
    }

    filtered[key] = deepClone(value);
  }

  return filtered;
}

function enforceCatalogKeyId(
  definition: unknown,
  serverId: string,
  override: Record<string, unknown>,
  source: ConfigSource,
  warnings: string[],
): unknown {
  if (!isPlainObject(definition)) return definition;

  if (typeof override.id === "string" && override.id !== serverId) {
    warnings.push(
      `Ignoring ${source.label} id override for ${serverId} from ${source.path}; catalog keys are authoritative.`,
    );
  }

  return { ...definition, id: serverId };
}

function filterUntrustedProjectEnv(
  serverId: string,
  value: unknown,
  sourcePath: string,
  warnings: string[],
): Record<string, string> | unknown {
  if (!isPlainObject(value)) return deepClone(value);

  const filtered: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isDangerousProjectEnvKey(serverId, key)) {
      warnings.push(
        `Ignoring untrusted project env override for ${serverId}.${key} from ${sourcePath}; process-affecting environment variables require /lsp trust.`,
      );
      continue;
    }
    filtered[key] = deepClone(entry) as string;
  }

  return filtered;
}

function filterUntrustedProjectCwd(
  serverId: string,
  value: unknown,
  sourcePath: string,
  projectRoot: string,
  warnings: string[],
): string | unknown | undefined {
  if (typeof value !== "string") return deepClone(value);

  if (isAbsolute(value)) {
    warnings.push(
      `Ignoring untrusted project cwd override for ${serverId} from ${sourcePath}; cwd must be relative to the project root.`,
    );
    return undefined;
  }

  const resolvedCwd = resolve(projectRoot, value);
  const relativeCwd = relative(projectRoot, resolvedCwd);
  if (relativeCwd.startsWith("..") || isAbsolute(relativeCwd)) {
    warnings.push(
      `Ignoring untrusted project cwd override for ${serverId} from ${sourcePath}; cwd must stay inside the project root.`,
    );
    return undefined;
  }

  return value;
}

function isDangerousProjectEnvKey(serverId: string, key: string): boolean {
  const upperKey = key.toUpperCase();
  if (upperKey === "PYTHONPATH") return !isPythonServerId(serverId);
  return (
    DANGEROUS_PROJECT_ENV_KEYS.has(upperKey) ||
    DANGEROUS_PROJECT_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix))
  );
}

function ignoredProjectServerFieldWarning(
  serverId: string,
  field: string,
  sourcePath: string,
  projectRoot: string,
): string {
  if (field === "command") {
    return `Ignoring trusted-only project override for ${serverId}.command from ${sourcePath}; run /lsp trust ${projectRoot} to allow executable overrides.`;
  }

  if (field === "install") {
    return `Ignoring trusted-only project override for ${serverId}.install from ${sourcePath}; install commands, package names, and package versions require /lsp trust ${projectRoot}.`;
  }

  return `Ignoring trusted-only project override for ${serverId}.${field} from ${sourcePath}; only filetypes, rootMarkers, settings, initializationOptions, env, and cwd are allowed before /lsp trust ${projectRoot}.`;
}
