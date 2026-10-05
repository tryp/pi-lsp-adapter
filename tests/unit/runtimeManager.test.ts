import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DidChangeTextDocumentNotification,
  DidOpenTextDocumentNotification,
  HoverRequest,
  InitializeRequest,
  PublishDiagnosticsNotification,
} from "vscode-languageserver-protocol";
import type { Disposable } from "vscode-jsonrpc";
import {
  LspRuntimeManager,
  MAX_DIAGNOSTICS_WAIT_MS,
  type OutsideWorkspaceRefusal,
} from "../../src/lsp/runtimeManager.js";
import type { LspConnection, LspServerProcess } from "../../src/lsp/client.js";
import { LspProcessRegistry, type ProcessProbe } from "../../src/lsp/processRegistry.js";
import type { LspInstallManager } from "../../src/install/manager.js";
import type { LoadLspConfigResult } from "../../src/config/loadConfig.js";
import type { ServerDefinition } from "../../src/registry/schema.js";

let tempDir: string;
let projectDir: string;
let registryPath: string;
let nextPid: number;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-lsp-runtime-"));
  projectDir = join(tempDir, "project");
  registryPath = join(tempDir, "lsp.pid.json");
  nextPid = 5000;
  await mkdir(join(projectDir, "src"), { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("LspRuntimeManager", () => {
  it("starts the configured server for a file, syncs it, records diagnostics, and registers the pid", async () => {
    await writeFile(join(projectDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(projectDir, "src", "index.ts"), "const value: string = 1;\n", "utf8");
    const connections: FakeConnection[] = [];
    const runtime = runtimeManager({
      connectionFactory: (process) => {
        const connection = new FakeConnection(process.pid!);
        connections.push(connection);
        return connection;
      },
    });

    const result = await runtime.diagnostics("src/index.ts");

    expect(result.serverId).toBe("vtsls");
    expect(result.rootDir).toBe(projectDir);
    expect(result.diagnostics[0]?.message).toBe("Type mismatch");
    expect(
      connections[0]?.notifications.find((entry) => entry.method === DidOpenTextDocumentNotification.method),
    ).toMatchObject({
      method: DidOpenTextDocumentNotification.method,
      params: { textDocument: { languageId: "typescript" } },
    });
    await expect(runtime.registry.list()).resolves.toEqual([
      expect.objectContaining({ serverId: "vtsls", rootDir: projectDir, pid: 5000, ownerPid: process.pid }),
    ]);
  });

  it("falls back to cwd as root when no root marker is found", async () => {
    await writeFile(join(projectDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    const runtime = runtimeManager();

    const result = await runtime.hover("src/index.ts", 0, 0);

    expect(result.rootDir).toBe(projectDir);
    expect(result.result?.contents).toMatchObject({ value: "hover text" });
  });

  it("rejects out-of-range positions before sending noisy LSP requests", async () => {
    await writeFile(join(projectDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    const runtime = runtimeManager();

    await expect(runtime.hover("src/index.ts", 99, 0)).rejects.toThrow(
      "line 100 was requested, but the file has 2 line(s)",
    );
    await expect(runtime.hover("src/index.ts", 0, 99)).rejects.toThrow("column 100 was requested on line 1");
    await expect(runtime.registry.list()).resolves.toEqual([]);
  });

  it("reports missing installed metadata without spawning", async () => {
    await writeFile(join(projectDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    const runtime = runtimeManager({ installed: false });

    const results = await runtime.startServer("vtsls");

    expect(results[0]).toMatchObject({ status: "missing" });
    await expect(runtime.registry.list()).resolves.toEqual([]);
  });

  it("does not trigger prompt installs from file-based runtime calls", async () => {
    await writeFile(join(projectDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    const runtime = runtimeManager({ installMode: "prompt" });

    await expect(runtime.diagnostics("src/index.ts")).rejects.toThrow("Run /lsp install vtsls");
    await expect(runtime.registry.list()).resolves.toEqual([]);
  });

  it("does not install missing servers while warming a read file", async () => {
    await writeFile(join(projectDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    const installManager = { ensureInstalled: vi.fn() } as unknown as LspInstallManager;
    const runtime = runtimeManager({ installMode: "auto", installManager });

    await expect(runtime.warmupFile("src/index.ts")).resolves.toBe(false);

    expect(installManager.ensureInstalled).not.toHaveBeenCalled();
    await expect(runtime.registry.list()).resolves.toEqual([]);
  });

  it("warms an installed server for a read file and syncs the document", async () => {
    await writeFile(join(projectDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(projectDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    await writeFile(
      join(tempDir, "lsp.lock.json"),
      JSON.stringify(
        {
          servers: {
            vtsls: {
              installer: "system",
              resolvedCommand: ["fake-ls", "--stdio"],
              installedAt: "2026-05-28T00:00:00.000Z",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const connections: FakeConnection[] = [];
    const runtime = runtimeManager({
      connectionFactory: (process) => {
        const connection = new FakeConnection(process.pid!);
        connections.push(connection);
        return connection;
      },
      installManager: { ensureInstalled: vi.fn() } as unknown as LspInstallManager,
    });

    await expect(runtime.warmupFile("src/index.ts")).resolves.toBe(true);

    expect(runtime.activeClients()).toEqual([{ id: `vtsls:${projectDir}`, serverId: "vtsls", rootDir: projectDir }]);
    expect(connections[0]?.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: DidOpenTextDocumentNotification.method,
          params: expect.objectContaining({ textDocument: expect.objectContaining({ languageId: "typescript" }) }),
        }),
      ]),
    );
    await expect(runtime.registry.list()).resolves.toEqual([expect.objectContaining({ serverId: "vtsls" })]);
  });

  it("refuses to start workspaces for files outside cwd", async () => {
    const outsideFile = join(tempDir, "outside.ts");
    await writeFile(outsideFile, "export const outside = 1;\n", "utf8");
    const runtime = runtimeManager();

    await expect(runtime.diagnostics(outsideFile)).rejects.toThrow("outside workspace");
    await expect(runtime.registry.list()).resolves.toEqual([]);
  });

  it("names the project root to add when refusing an out-of-scope file", async () => {
    // The remedy must be the marked project root, not the file's own directory:
    // adding a deep directory leaves the server's detected root outside the
    // added root, and selectServerForFile then falls back to the session cwd.
    const siblingRoot = join(tempDir, "sibling");
    await mkdir(join(siblingRoot, "src", "deep"), { recursive: true });
    await writeFile(join(siblingRoot, "package.json"), "{}\n", "utf8");
    const outsideFile = join(siblingRoot, "src", "deep", "index.ts");
    await writeFile(outsideFile, "export const outside = 1;\n", "utf8");
    const runtime = runtimeManager();

    await expect(runtime.diagnostics(outsideFile)).rejects.toThrow(
      `Call lsp_add_workspace_root(directory="${siblingRoot}"), then retry.`,
    );
  });

  it("falls back to the file's directory when no project marker exists above it", async () => {
    const looseDir = join(tempDir, "loose");
    await mkdir(looseDir, { recursive: true });
    const outsideFile = join(looseDir, "scratch.ts");
    await writeFile(outsideFile, "export const outside = 1;\n", "utf8");
    const runtime = runtimeManager();

    await expect(runtime.diagnostics(outsideFile)).rejects.toThrow(
      `Call lsp_add_workspace_root(directory="${looseDir}"), then retry.`,
    );
  });

  it("labels a read-triggered warmup refusal as warmup, not a tool query", async () => {
    // Warmup runs from the plain read/edit/write hook, so counting it under
    // "from LSP tools" in /lsp status would misreport what actually failed.
    const outsideFile = join(tempDir, "outside.ts");
    await writeFile(outsideFile, "export const outside = 1;\n", "utf8");
    const refusals: OutsideWorkspaceRefusal[] = [];
    const runtime = runtimeManager({ onOutsideWorkspace: (refusal) => refusals.push(refusal) });

    await expect(runtime.warmupFile(outsideFile)).resolves.toBe(false);

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ filePath: outsideFile, reason: "warmup" });
  });

  it("suggests a directory target itself rather than its parent", async () => {
    const outsideDir = join(tempDir, "checkout");
    await mkdir(join(outsideDir, "src"), { recursive: true });
    await writeFile(join(outsideDir, "package.json"), "{}\n", "utf8");
    const runtime = runtimeManager();

    expect(runtime.suggestWorkspaceRoot(outsideDir)).toBe(outsideDir);
  });

  it("matches multi-segment root markers the same way root detection does", async () => {
    const marked = join(tempDir, "project-marker");
    await mkdir(join(marked, "sub"), { recursive: true });
    await mkdir(join(marked, "sub", "deep"), { recursive: true });
    await writeFile(join(marked, "sub", "marker.txt"), "x\n", "utf8");
    const runtime = runtimeManager({
      onOutsideWorkspace: undefined,
    });
    // The test server's only marker is package.json, so add one that needs the
    // same "sub/inner" joining detectRoot performs.
    (runtime as unknown as { config: { catalog: { servers: Record<string, { rootMarkers: string[] }> } } }).config.catalog.servers.vtsls!.rootMarkers.push(
      "sub/marker.txt",
      "sub\\marker.txt",
    );

    expect(runtime.suggestWorkspaceRoot(join(marked, "sub", "deep", "index.ts"))).toBe(marked);
  });

  it("keeps mixed-language directories from sharing a cached suggestion", async () => {
    // A .py and a .rs in one directory must each be pointed at the root their
    // own server detects, so the memo key includes the marker set, not just
    // the directory.
    const mixedRoot = join(tempDir, "mixed");
    await mkdir(join(mixedRoot, "rust"), { recursive: true });
    await writeFile(join(mixedRoot, "pyproject.toml"), "{}\n", "utf8");
    await writeFile(join(mixedRoot, "rust", "Cargo.toml"), "{}\n", "utf8");
    const runtime = runtimeManager();
    const servers = (
      runtime as unknown as {
        config: {
          catalog: {
            servers: Record<string, { id: string; rootMarkers: string[]; filetypes: string[] }>;
          };
        };
      }
    ).config.catalog.servers;
    servers.pyright = {
      ...servers.vtsls!,
      id: "pyright",
      filetypes: ["python"],
      rootMarkers: ["pyproject.toml"],
    };
    servers.rustAnalyzer = {
      ...servers.vtsls!,
      id: "rustAnalyzer",
      filetypes: ["rust"],
      rootMarkers: ["Cargo.toml"],
    };

    // Both asked twice: the second round is served from the memo.
    for (let round = 0; round < 2; round += 1) {
      expect(runtime.suggestWorkspaceRoot(join(mixedRoot, "main.py"))).toBe(mixedRoot);
      expect(runtime.suggestWorkspaceRoot(join(mixedRoot, "rust", "lib.rs"))).toBe(
        join(mixedRoot, "rust"),
      );
    }
  });

  it("reports every refusal to the outside-workspace counter", async () => {
    const outsideFile = join(tempDir, "outside.ts");
    await writeFile(outsideFile, "export const outside = 1;\n", "utf8");
    const refusals: OutsideWorkspaceRefusal[] = [];
    const runtime = runtimeManager({ onOutsideWorkspace: (refusal) => refusals.push(refusal) });

    await expect(runtime.diagnostics(outsideFile)).rejects.toThrow("outside workspace");

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      filePath: outsideFile,
      reason: "tool",
    });
    expect(refusals[0]?.workspaceRoots).toEqual([projectDir]);
  });

  it("returns no baseline instead of throwing when an edit target is out of scope", async () => {
    // Regression guard for the edit-tool outage: the auto-diag pre-edit hook
    // calls cachedDiagnostics for every edit, so a throw here made any file
    // outside the workspace unwritable, not merely unanalyzable.
    const outsideFile = join(tempDir, "outside.ts");
    await writeFile(outsideFile, "export const outside = 1;\n", "utf8");
    const refusals: OutsideWorkspaceRefusal[] = [];
    const runtime = runtimeManager({ onOutsideWorkspace: (refusal) => refusals.push(refusal) });

    expect(runtime.cachedDiagnostics(outsideFile)).toBeUndefined();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ filePath: outsideFile, reason: "auto-diag-baseline" });
    await expect(runtime.registry.list()).resolves.toEqual([]);
  });

  it("queries only active clients for workspace symbols when no server id is provided", async () => {
    const connections: FakeConnection[] = [];
    const runtime = runtimeManager({
      connectionFactory: (process) => {
        const connection = new FakeConnection(process.pid!);
        connections.push(connection);
        return connection;
      },
    });

    await expect(runtime.workspaceSymbols("value")).resolves.toEqual([]);

    expect(connections).toEqual([]);
  });

  it("reports unsupported server capabilities before sending a request", async () => {
    await writeFile(join(projectDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    const runtime = runtimeManager({ connectionFactory: (process) => new FakeConnection(process.pid!, {}) });

    await expect(runtime.hover("src/index.ts", 0, 0)).rejects.toThrow("does not support LSP hover");
  });

  it("does not replace a client when the old process refuses to exit during restart", async () => {
    await writeFile(join(projectDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(projectDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    let spawns = 0;
    const runtime = runtimeManager({
      spawner: () => {
        spawns += 1;
        return new NonExitingFakeProcess(nextPid++);
      },
    });

    await runtime.diagnostics("src/index.ts");
    const result = await runtime.restartServer("vtsls");

    expect(result[0]).toMatchObject({ status: "error" });
    expect(spawns).toBe(1);
    await expect(runtime.registry.list()).resolves.toEqual([expect.objectContaining({ serverId: "vtsls", pid: 5000 })]);
  });
});

function runtimeManager(
  options: {
    installed?: boolean;
    installMode?: LoadLspConfigResult["installMode"];
    spawner?: () => LspServerProcess;
    connectionFactory?: (process: LspServerProcess) => LspConnection;
    installManager?: LspInstallManager;
    diagnosticsWaitMs?: number;
    /** Leave the option unset so the built-in default applies. */
    omitDiagnosticsWaitMs?: boolean;
    /** Per-server override under test. */
    serverDiagnosticsWaitMs?: number;
    onOutsideWorkspace?: (refusal: OutsideWorkspaceRefusal) => void;
  } = {},
): LspRuntimeManager & {
  registry: LspProcessRegistry;
} {
  const registry = new LspProcessRegistry({
    path: registryPath,
    ownerId: "owner-test",
    probe: fakeProbe(),
    terminateGraceMs: 0,
  });
  const runtime = new LspRuntimeManager({
    cwd: projectDir,
    ownerId: "owner-test",
    config: config(options.installMode ?? "auto", options.serverDiagnosticsWaitMs),
    installManager: options.installManager ?? fakeInstallManager(options.installed ?? true),
    processRegistry: registry,
    lockfileOptions: { lockfilePath: join(tempDir, "lsp.lock.json") },
    spawner: options.spawner ?? (() => new FakeProcess(nextPid++)),
    connectionFactory: options.connectionFactory ?? ((process) => new FakeConnection(process.pid!)),
    ...(options.omitDiagnosticsWaitMs
      ? {}
      : { diagnosticsWaitMs: options.diagnosticsWaitMs ?? 0 }),
    requestTimeoutMs: 500,
    shutdownGraceMs: 0,
    ...(options.onOutsideWorkspace ? { onOutsideWorkspace: options.onOutsideWorkspace } : {}),
  }) as LspRuntimeManager & { registry: LspProcessRegistry };
  runtime.registry = registry;
  return runtime;
}

function config(
  installMode: LoadLspConfigResult["installMode"],
  diagnosticsWaitMs?: number,
): LoadLspConfigResult {
  return {
    catalog: {
      servers: { vtsls: { ...serverDefinition(), diagnosticsWaitMs } },
    },
    warnings: [],
    installMode,
    warmup: true,
  };
}

function serverDefinition(): ServerDefinition {
  return {
    id: "vtsls",
    displayName: "JavaScript/TypeScript Language Server (VTSLS)",
    filetypes: ["typescript"],
    rootMarkers: ["package.json"],
    install: { type: "system", command: ["fake-ls"] },
    command: ["fake-ls", "--stdio"],
    env: {},
    settings: {},
    initializationOptions: {},
    lazy: true,
  };
}

function fakeInstallManager(installed: boolean): LspInstallManager {
  return {
    ensureInstalled: async (serverId: string) =>
      installed
        ? {
            status: "installed",
            serverId,
            installedNow: false,
            metadata: {
              installer: "system",
              resolvedCommand: ["fake-ls", "--stdio"],
              installedAt: "2026-05-28T00:00:00.000Z",
            },
          }
        : {
            status: "missing",
            serverId,
            installCommand: `/lsp install ${serverId}`,
            message: `${serverId} is not installed.`,
          },
  } as LspInstallManager;
}

function fakeProbe(): ProcessProbe {
  return {
    isRunning: () => true,
    commandMatches: () => true,
    terminate: () => undefined,
  };
}

class FakeProcess extends EventEmitter implements LspServerProcess {
  constructor(readonly pid: number) {
    super();
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.emit("exit", null, signal ?? null);
    return true;
  }
}

class NonExitingFakeProcess extends EventEmitter implements LspServerProcess {
  constructor(readonly pid: number) {
    super();
  }

  kill(): boolean {
    return true;
  }
}

describe("diagnostics publication waiting", () => {
  it("waits for the synced version when the server reports versions", async () => {
    await writeFile(join(projectDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(projectDir, "src", "index.ts"), "const value: string = 1;\n", "utf8");

    const runtime = runtimeManager({
      diagnosticsWaitMs: 2000,
      connectionFactory: (process) =>
        new FakeConnection(process.pid!, undefined, {
          publishDelayMs: 60,
          publishVersion: 1,
        }),
    });

    const result = await runtime.diagnostics("src/index.ts");

    expect(result.diagnostics[0]?.message).toBe("Type mismatch");
  });

  it("returns promptly for a version-less publication instead of burning the timeout", async () => {
    await writeFile(join(projectDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(projectDir, "src", "index.ts"), "const value: string = 1;\n", "utf8");

    // FakeConnection publishes with no `version`, matching servers that omit
    // the optional field. A `published < synced` comparison is always false
    // for undefined, so a naive loop would spin to the deadline.
    const runtime = runtimeManager({ diagnosticsWaitMs: 3000 });

    const started = Date.now();
    const result = await runtime.diagnostics("src/index.ts");
    const elapsed = Date.now() - started;

    expect(result.diagnostics[0]?.message).toBe("Type mismatch");
    expect(elapsed).toBeLessThan(1500);
  });
});

describe("diagnostics wait bound", () => {
  it("defaults past the old 350ms bound so a slow server is not timed out", async () => {
    // Measured with scripts/lsp_publish_latency.py: pyright on a large Python
    // project publishes 1.5-2.3s after a didChange. Under the old 350ms
    // default every one of those reads timed out and the edit got no steer,
    // which is why coverage collapsed after the 2026-10-03 deploy.
    await writeFile(join(projectDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(projectDir, "src", "index.ts"), "const value: string = 1;\n", "utf8");

    const runtime = runtimeManager({
      omitDiagnosticsWaitMs: true,
      connectionFactory: (process) =>
        new FakeConnection(process.pid!, undefined, {
          publishDelayMs: 400,
          publishVersion: 1,
        }),
    });

    const result = await runtime.diagnostics("src/index.ts");

    expect(result.published).toBe(true);
    expect(result.diagnostics[0]?.message).toBe("Type mismatch");
  });

  it("uses the server's own diagnosticsWaitMs over the manager default", async () => {
    await writeFile(join(projectDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(projectDir, "src", "index.ts"), "const value: string = 1;\n", "utf8");

    // Manager bound is 0ms, so only the per-server value can let a delayed
    // publication through.
    const runtime = runtimeManager({
      diagnosticsWaitMs: 0,
      serverDiagnosticsWaitMs: 1500,
      connectionFactory: (process) =>
        new FakeConnection(process.pid!, undefined, {
          publishDelayMs: 300,
          publishVersion: 1,
        }),
    });

    const result = await runtime.diagnostics("src/index.ts");

    expect(result.published).toBe(true);
    expect(result.diagnostics[0]?.message).toBe("Type mismatch");
  });

  it("reports published=false when the bound expires before the server answers", async () => {
    await writeFile(join(projectDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(projectDir, "src", "index.ts"), "const value: string = 1;\n", "utf8");

    const runtime = runtimeManager({
      serverDiagnosticsWaitMs: 100,
      connectionFactory: (process) =>
        new FakeConnection(process.pid!, undefined, {
          publishDelayMs: 800,
          publishVersion: 1,
        }),
    });

    const result = await runtime.diagnostics("src/index.ts");

    // The caller must be able to tell "the server has not answered" from
    // "the file is clean"; that distinction is what the skip counters count.
    expect(result.published).toBe(false);
  });

  it("rejects a publication whose version predates the synced version", async () => {
    // The publication counter alone would accept this one: it arrived after
    // the sample. But it answers an older document version -- the still-in-
    // flight reply to the *previous* edit, which is exactly the stale read
    // that produced false-positive "new error" complaints before 2026-10-03.
    // Waiting for a real answer is what the raised bound buys, so the version
    // signal has to win over the counter.
    await writeFile(join(projectDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(projectDir, "src", "index.ts"), "const value: string = 1;\n", "utf8");

    const runtime = runtimeManager({
      serverDiagnosticsWaitMs: 300,
      connectionFactory: (process) =>
        new FakeConnection(process.pid!, undefined, {
          publishDelayMs: 50,
          publishVersion: 0,
        }),
    });

    const result = await runtime.diagnostics("src/index.ts");

    expect(result.published).toBe(false);
  });

  it("clamps a configured wait to the hard ceiling", async () => {
    await writeFile(join(projectDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(projectDir, "src", "index.ts"), "const value: string = 1;\n", "utf8");

    // Per-server config can come from an untrusted project checkout, and this
    // wait sits on the agent's critical path: a hostile 10-minute bound must
    // not become a 10-minute edit.
    const runtime = runtimeManager({
      serverDiagnosticsWaitMs: 600_000,
      connectionFactory: (process) =>
        new FakeConnection(process.pid!, undefined, { publishDelayMs: 5, publishVersion: 1 }),
    });

    const resolved = (
      runtime as unknown as { diagnosticsWaitMsFor(serverId: string): number }
    ).diagnosticsWaitMsFor("vtsls");

    expect(resolved).toBe(MAX_DIAGNOSTICS_WAIT_MS);
  });

  it("waits for a version-less publication that arrives after the sync", async () => {
    // A server that omits `version` used to sleep for the whole bound and
    // then accept whatever was cached. Polling the publication counter is
    // both faster and stricter: it only accepts a publication newer than the
    // one sampled before the sync.
    await writeFile(join(projectDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(projectDir, "src", "index.ts"), "const value: string = 1;\n", "utf8");

    const runtime = runtimeManager({
      serverDiagnosticsWaitMs: 2000,
      connectionFactory: (process) =>
        new FakeConnection(process.pid!, undefined, { publishDelayMs: 120 }),
    });

    const started = Date.now();
    const result = await runtime.diagnostics("src/index.ts");
    const elapsed = Date.now() - started;

    expect(result.published).toBe(true);
    expect(result.diagnostics[0]?.message).toBe("Type mismatch");
    // Arrived by polling, not by exhausting a 2000ms bound.
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("cachedDiagnostics (pre-edit baseline)", () => {
  it("returns undefined when no client exists for the file", async () => {
    await writeFile(join(projectDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(projectDir, "src", "index.ts"), "const x = 1;\n", "utf8");

    const runtime = runtimeManager();

    // No server has been started for this file: there is no baseline, and the
    // lookup must NOT start one or sync the file.
    expect(runtime.cachedDiagnostics("src/index.ts")).toBeUndefined();
  });

  it("does not return a stale version-less publication cached before the sync", async () => {
    // The exact regression the version-less fallback can introduce: a server
    // that never sends `version` already published for this uri, so a naive
    // "any publication is good enough" check would return that OLD result
    // immediately after the edit and report pre-edit errors as new.
    await writeFile(join(projectDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(projectDir, "src", "index.ts"), "const value: string = 1;\n", "utf8");

    const stale = "cached from an earlier sync";
    const fresh = "published after this sync";
    const published: string[] = [];
    const runtime = runtimeManager({
      diagnosticsWaitMs: 2500,
      connectionFactory: (process) =>
        new FakeConnection(process.pid!, undefined, {
          // Publish an initial (stale) set on didOpen, then a fresh set on a
          // later didChange, with no version field in either.
          publishMessages: [stale, fresh],
          publishDelayMs: 80,
        }),
    });

    // First call opens the document and caches the STALE publication.
    await runtime.diagnostics("src/index.ts");

    // Second call re-syncs (content differs) and must NOT settle for the
    // stale publication still sitting in the cache.
    await writeFile(join(projectDir, "src", "index.ts"), "const value: string = 2;\n", "utf8");
    const result = await runtime.diagnostics("src/index.ts");

    expect(result.diagnostics[0]?.message).toBe(fresh);
  });

  it("prefers the client whose root actually contains the file", async () => {
    // A file covered by more than one live client must not pick up another
    // client's diagnostics. The most specific (longest) matching root wins.
    const nested = join(projectDir, "packages", "app");
    await mkdir(join(nested, "src"), { recursive: true });
    await writeFile(join(projectDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(nested, "package.json"), "{}\n", "utf8");
    await writeFile(join(nested, "src", "index.ts"), "const value: string = 1;\n", "utf8");

    const runtime = runtimeManager();
    // Warm the nested root first so its client exists, then the outer root.
    await runtime.diagnostics("packages/app/src/index.ts");
    await runtime.diagnostics("packages/app/src/index.ts");

    const baseline = runtime.cachedDiagnostics("packages/app/src/index.ts");

    expect(baseline?.[0]?.message).toBe("Type mismatch");
  });

  it("returns cached diagnostics without starting another client", async () => {
    await writeFile(join(projectDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(projectDir, "src", "index.ts"), "const value: string = 1;\n", "utf8");

    const spawner = vi.fn(() => new FakeProcess(nextPid++));
    const runtime = runtimeManager({ spawner });

    await runtime.diagnostics("src/index.ts");
    const spawnsAfterWarmup = spawner.mock.calls.length;

    const baseline = runtime.cachedDiagnostics("src/index.ts");

    expect(baseline?.[0]?.message).toBe("Type mismatch");
    expect(spawner.mock.calls.length).toBe(spawnsAfterWarmup);
  });
});

class FakeConnection implements LspConnection {
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();

  constructor(
    private readonly pid: number,
    private readonly capabilities: Record<string, unknown> = {
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
    },
    private readonly publishOptions: {
      publishDelayMs?: number;
      publishVersion?: number;
      publishMessages?: string[];
    } = {},
  ) {}

  listen(): void {}

  async sendRequest<R>(method: string): Promise<R> {
    if (method === InitializeRequest.method) {
      return { capabilities: this.capabilities } as R;
    }
    if (method === HoverRequest.method) {
      return { contents: { kind: "markdown", value: "hover text" } } as R;
    }
    return null as R;
  }

  async sendNotification(method: string, params?: unknown): Promise<void> {
    this.notifications.push({ method, params });
    if (!isDidOpenParams(params)) return;
    if (
      method !== DidOpenTextDocumentNotification.method &&
      method !== DidChangeTextDocumentNotification.method
    ) {
      return;
    }

    // A scripted sequence lets a test give distinct diagnostics to successive
    // publications, which is how a stale cached publication is detected.
    const messages = this.publishOptions.publishMessages;
    const message =
      messages && messages.length > 0
        ? (messages.shift() as string)
        : "Type mismatch";

    const publish = () =>
      this.notificationHandlers.get(PublishDiagnosticsNotification.method)?.({
        uri: params.textDocument.uri,
        diagnostics: [
          {
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
            severity: 1,
            message,
            source: `fake-${this.pid}`,
          },
        ],
        // Servers may omit `version`; only include it when configured.
        ...(this.publishOptions.publishVersion === undefined
          ? {}
          : { version: this.publishOptions.publishVersion }),
      });

    const delayMs = this.publishOptions.publishDelayMs ?? 0;
    if (delayMs > 0) setTimeout(publish, delayMs);
    else publish();
  }

  onNotification(method: string, handler: (params: unknown) => void): Disposable {
    this.notificationHandlers.set(method, handler);
    return { dispose: () => this.notificationHandlers.delete(method) };
  }

  onRequest(): Disposable {
    return { dispose: () => undefined };
  }

  dispose(): void {}
  end(): void {}
}

function isDidOpenParams(value: unknown): value is { textDocument: { uri: string } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "textDocument" in value &&
    typeof value.textDocument === "object" &&
    value.textDocument !== null &&
    "uri" in value.textDocument &&
    typeof value.textDocument.uri === "string"
  );
}
