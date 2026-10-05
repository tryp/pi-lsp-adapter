# pi-lsp-adapter

Language-server intelligence for [Pi](https://github.com/earendil-works/pi) agents: diagnostics, hover/type info, definitions, references, and symbol search on demand.

`pi-lsp-adapter` gives Pi a small set of read-only LSP tools without turning startup into an IDE boot. Language servers are lazy at session startup, installed servers can be warmed in the background when Pi reads source files, managed installs are isolated under Pi's runtime directory, and large LSP responses are paginated through a short-lived cache so they do not flood the context window.

## Why this exists

Agents make better edits when they can ask semantic questions instead of guessing from text search alone:

- _What type is this symbol?_
- _Where is this function defined?_
- _What references will this change affect?_
- _Did the language server report a type or lint error?_

LSP already answers those questions. This extension makes those answers available to Pi as compact, read-only tools. It starts servers only when needed, keeps missing-server installs explicit by default, and returns the first useful page instead of dumping thousands of references into the model.

## Install

Install from npm:

```bash
pi install npm:pi-lsp-adapter
```

Or install directly from git:

```bash
pi install git:github.com/nikmmd/pi-lsp-adapter
```

Restart Pi after installation, then check the extension:

```text
/lsp status
```

For local development from a checkout:

```bash
git clone https://github.com/nikmmd/pi-lsp-adapter.git
cd pi-lsp-adapter
npm install
pi -e "$PWD"
```

The default install mode is `prompt`: agent tool calls will not silently install missing language servers. Install servers explicitly with `/lsp install <serverId>`, or set `installMode` to `auto` if you want first-use installation.

## What happens on first use

| You do this                                            | What happens                                                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Run `/lsp` in an interactive Pi session                | Pi opens a compact LSP panel showing configured servers, install state, tracked processes, and config warnings.                                 |
| Run `/lsp status`                                      | Pi prints the same status as text.                                                                                                              |
| Run `/lsp install pyright`                             | The server is installed under `~/.pi/agent/lsp/`, and the resolved command is recorded in Pi's LSP lockfile.                                    |
| Read a supported source file with Pi's `read` tool     | If `warmup` is enabled, the matching installed server is started in the background. Missing servers are ignored.                                |
| Ask for diagnostics/hover/definitions on a source file | The extension detects the filetype and project root, reuses a warmed server or starts the matching server if needed, then runs the LSP request. |
| Query many references or symbols                       | The first ranked page is returned immediately. If more pages exist, the result includes a `resultId` for `lsp_more`.                            |
| Configure a Mason/Nix/system binary                    | Pi uses that command but does not own, update, or uninstall it. Use global config for executable overrides.                                     |

## Quick start

```text
/lsp status
/lsp install vtsls
```

Then ask Pi something that benefits from semantic context:

```text
Check diagnostics for src/index.ts, then use hover on the exported function before editing it.
```

Useful first commands:

```text
/lsp doctor vtsls
/lsp install pyright
/lsp start
```

## Tools

The extension registers these read-only tools:

| Tool                    | Use it for                                            | Required input                                         |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| `lsp_diagnostics`       | Compiler/type/lint diagnostics for one file           | `filePath`                                             |
| `lsp_hover`             | Type, signature, and documentation at a position      | `filePath`, 1-based `line`, 1-based `column`           |
| `lsp_definition`        | Definition locations for a symbol                     | `filePath`, 1-based `line`, 1-based `column`           |
| `lsp_references`        | Reference locations for a symbol                      | `filePath`, 1-based `line`, 1-based `column`           |
| `lsp_document_symbols`  | Classes, functions, variables, and other file symbols | `filePath`                                             |
| `lsp_workspace_symbols` | Symbol search across active or selected workspaces    | `query`; optional `serverId`                           |
| `lsp_more`              | Next page from a cached multi-page LSP result         | Exact `resultId` returned by a previous paginated call |

Examples:

```text
lsp_diagnostics({ filePath: "src/index.ts" })
```

```text
lsp_hover({ filePath: "src/index.ts", line: 42, column: 13 })
```

```text
lsp_workspace_symbols({ query: "RuntimeManager", serverId: "vtsls" })
```

Line and column inputs are 1-based. For hover, definitions, and references, put the column on the identifier token itself rather than on whitespace or an import path string.

## Supported servers

Built-in catalog entries currently include:

| Server          | Languages/filetypes              | Managed installer |
| --------------- | -------------------------------- | ----------------- |
| `vtsls`         | JavaScript, JSX, TypeScript, TSX | npm               |
| `pyright`       | Python                           | npm               |
| `gopls`         | Go                               | go                |
| `rust-analyzer` | Rust                             | GitHub release    |
| `yamlls`        | YAML                             | npm               |
| `jsonls`        | JSON, JSONC                      | npm               |
| `jdtls`         | Java                             | GitHub release    |

You can override these definitions or add new server definitions in config.

## Configuration

Most users only need one file:

```text
~/.pi/agent/lsp.json
```

If that file does not exist, the extension behaves as if this config were present:

```json
{
  "installMode": "prompt",
  "warmup": true,
  "servers": {}
}
```

`servers: {}` means "use the built-in server catalog unchanged". Add entries only when you want to override a built-in server or define a new one.

### Config files and merge order

| Priority | Path                   | Purpose                                                                                                          |
| -------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1        | built-in catalog       | Default server definitions for `vtsls`, `pyright`, `gopls`, `rust-analyzer`, `yamlls`, etc.                      |
| 2        | `~/.pi/agent/lsp.json` | User-global config. Best place for executable, install, PATH, `installMode`, and `warmup`.                       |
| 3        | `.pi/lsp.json`         | Project-local config. Safe server fields are honored before trust; process-starting fields require `/lsp trust`. |

> Path gotcha: config is the file `~/.pi/agent/lsp.json`. Runtime state lives under the directory `~/.pi/agent/lsp/`.

### Runtime paths

Do not edit these by hand unless you are debugging or cleaning up state:

| Path                            | Purpose                                                    |
| ------------------------------- | ---------------------------------------------------------- |
| `~/.pi/agent/lsp/packages/`     | Pi-managed language-server installs                        |
| `~/.pi/agent/lsp/bin/`          | Pi-managed executable links                                |
| `~/.pi/agent/lsp/lsp.lock.json` | Resolved managed install metadata                          |
| `~/.pi/agent/lsp/logs/`         | Language-server logs                                       |
| `~/.pi/agent/lsp/pids/`         | Per-session process registries used for lifecycle cleanup  |
| `~/.pi/agent/lsp/workspaces/`   | Per-server workspaces, for example JDT LS data directories |
| `~/.pi/agent/lsp/cache/`        | Runtime caches owned by the extension                      |

Do not put extension source code under `~/.pi/agent/lsp/`; that directory is only for runtime state.

### Local deployment

For a local development checkout, keep Pi pointed at the deployed package
mirror, not at `~/src/pi-lsp-adapter`:

```bash
cd ~/src/pi-lsp-adapter
make test
make deploy       # copy, verify dependencies and commit stamp, then smoke-test
make verify       # independently check the deployed mirror
```

`make deploy` runs a fresh pi process with only the deployed extension enabled.
It verifies tool registration and reaches `agent_end`, so extension-load errors
and incompatible host APIs fail before normal sessions use the change. Do not
replace it with a hand-written `rsync --delete`.

### Top-level config fields

| Field                   | Default                             | Behavior                                                                                       |
| ----------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `installMode`           | `"prompt"`                          | Missing servers are installed only when explicitly requested or interactively confirmed.       |
| `warmup`                | `true`                              | Pi `read` calls for supported source files start matching installed servers in the background. |
| `servers`               | `{}`                                | Per-server overrides merged into the built-in catalog.                                         |
| `extraWorkspaceRoots`   | `[]`                                | Extra directories whose files may be queried. The session cwd is always in scope.              |
| `autoWorkspaceRoots`    | `~/src`, `~/.pi/worktree-checkouts` | Trees under which an out-of-scope project is added without asking.                             |
| `autoWorkspaceRootMode` | `"trusted"`                         | `"trusted"`, `"all"`, or `"off"`: how far automatic widening goes.                             |

`installMode` can be:

| Mode     | Behavior                                                                    |
| -------- | --------------------------------------------------------------------------- |
| `prompt` | Install only when explicitly requested or interactively confirmed.          |
| `auto`   | Install missing servers automatically when an LSP tool needs them.          |
| `off`    | Never install automatically. Use system commands or explicit installs only. |

`warmup` never prompts and never installs missing servers. It only prepares already-installed servers after Pi reads a matching source file. `lazy` still means servers do not start at session startup.

### Files outside the workspace

Tools refuse to start a server for a file that is outside every workspace root. The refusal names the directory to add, and it names the _project_ directory rather than the file's own directory: a server resolves its root from project markers, so adding only `src/agents` would leave the detected root outside the added root and the query would run against the session cwd instead.

```
Refusing to start LSP for /checkout/src/index.ts; target is outside workspace /repo. Call lsp_add_workspace_root(directory="/checkout"), then retry
```

Most of the time there is no step to take. A project under one of your own trees is added automatically the first time a tool touches it, because a refusal that names a directory the agent then has to act on costs a turn and can end a session with no LSP tools left in it. `autoWorkspaceRoots` defaults to `~/src` and `~/.pi/worktree-checkouts`, and `autoWorkspaceRootMode` decides how far that goes:

| `autoWorkspaceRootMode` | Behavior                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `"trusted"` (default)   | Add the suggested root when it sits under `autoWorkspaceRoots`. Otherwise refuse, with the remedy.               |
| `"all"`                 | Add any suggested project root. Convenient, and it widens what a server will execute code from, so it is opt-in. |
| `"off"`                 | Never add automatically; every refusal names the directory to add.                                               |

Two degenerate suggestions are never auto-added: `/` and `$HOME`. A file at `/x.ts` or `~/x.ts` walks up to one of them, and adding either puts a whole filesystem in scope.

Two more ways to widen the scope explicitly:

- `lsp_add_workspace_root <dir>` for the current session. Servers start lazily, per project, on the first query against a file there.
- `extraWorkspaceRoots` in `~/.pi/agent/lsp.json` for every session. Entries are literal paths, so a directory that holds many checkouts (for example `~/.pi/worktree-checkouts`) brings all of them into scope at once; each checkout still gets its own server root and its own lazily started process.

Every automatic widening is counted (`autoAdded`, plus the roots added) and shows up in `/lsp status` and the session log: silent widening is how a session ends up analyzing four projects it was never told about.

### LSP failures never fail an edit

The auto-diag baseline runs in front of every `edit` and `write`, and an exception escaping that hook fails the tool call — so an out-of-scope path once made a file unwritable. Diagnostics are strictly an enhancement here: the whole handler is guarded, and each failure is counted (`baseline_failed`, `no_client`, `post_edit_failed`) rather than propagated. Read warmup is fire-and-forget and already ignores out-of-scope targets.

Refusals are counted per session and summarized by `/lsp status`, split by what triggered them (LSP tool, read warmup, auto-diag baseline). Each flush appends an `lsp_workspace_scope` entry to the session log with `cumulative` counters for the session and `sinceLastEntry` counters for that batch, so summing entries does not multiply the totals. A failing `appendEntry` (read-only or full session file) leaves the batch pending instead of breaking the caller; the cumulative totals are unaffected.

### Common config snippets

Disable read warmup:

```json
{
  "warmup": false
}
```

Auto-install missing servers on first explicit LSP tool use:

```json
{
  "installMode": "auto"
}
```

Tune Pyright analysis from project config without changing executables:

```json
{
  "servers": {
    "pyright": {
      "settings": {
        "python": {
          "analysis": {
            "diagnosticMode": "workspace"
          }
        }
      }
    }
  }
}
```

### Server override fields

A server definition can include:

| Field                   | Description                                                 |
| ----------------------- | ----------------------------------------------------------- |
| `displayName`           | Human-readable name shown in status output                  |
| `filetypes`             | Filetypes handled by the server                             |
| `rootMarkers`           | Files/directories used to detect the project root           |
| `install`               | Managed install spec: `npm`, `go`, `github`, or `system`    |
| `command`               | Command used to start the language server                   |
| `cwd`                   | Working directory for the server command                    |
| `env`                   | Environment overrides; supports `$env:VAR` references       |
| `settings`              | LSP settings returned through `workspace/configuration`     |
| `initializationOptions` | LSP initialization options                                  |
| `lazy`                  | Whether the server should avoid session-start eager startup |
| `diagnosticsWaitMs`     | How long to wait for post-edit diagnostics for this server  |

`command` supports placeholders such as `{installBin}`, `{installDir}`, `{platform}`, and `{workspaceDir}`. Relative path-like values are resolved from the detected project root, and `~` is expanded.

Project config is intentionally conservative. In untrusted projects, executable and install overrides are ignored; put those in global config.

### `diagnosticsWaitMs`

After an edit, the adapter asks the server for diagnostics and waits for a publication that corresponds to the document version it just sent. Servers differ by an order of magnitude here: a warm `vtsls` publishes in well under a second, while `pyright` on a large Python project has been measured at 1.5-2.3s per edit. A wait that suits the fast server silently produces no feedback at all on the slow one.

The default is 5000ms. It costs nothing when the server answers quickly, because the wait ends as soon as the matching publication arrives; it only bounds the case where the server never publishes.

Override it per server, and size it at roughly **twice that server's p95 publish latency**:

```json
{
  "servers": {
    "pyright": { "diagnosticsWaitMs": 8000 }
  }
}
```

Measure your own server before choosing a value rather than copying one:

```bash
# from pi-session-analysis
make measure-lsp-latency ARGS="--file /path/to/a/representative/file.py"
```

`/lsp status` reports the bound in effect per server along with the auto-diag outcome counters for the session, including how often the wait expired before the server answered.

## Using existing LSP binaries

You do not need Pi to manage every language server. If you already have servers installed through Mason.nvim, your distro, Nix, mise/asdf, or another tool, point `pi-lsp-adapter` at those binaries with global config.

Prefer global config for executable overrides:

```text
~/.pi/agent/lsp.json
```

Example: use Mason.nvim's Pyright:

```json
{
  "servers": {
    "pyright": {
      "install": {
        "type": "system",
        "command": ["~/.local/share/nvim/mason/bin/pyright-langserver", "--stdio"]
      }
    }
  }
}
```

For `type: "system"`, `command` is inferred from `install.command` when omitted.

Example: use a binary already on `PATH`:

```json
{
  "servers": {
    "gopls": {
      "install": {
        "type": "system",
        "command": ["gopls"]
      }
    }
  }
}
```

## Managed install overrides

Use `install` without `type: "system"` when you want Pi to own the install lifecycle. In `prompt` mode, the server is still missing until you run `/lsp install <serverId>`. The resolved install metadata is then written to `~/.pi/agent/lsp/lsp.lock.json`.

Pin a managed npm server version:

```json
{
  "servers": {
    "pyright": {
      "install": {
        "type": "npm",
        "packages": {
          "pyright": "1.1.410"
        },
        "bin": "pyright-langserver"
      }
    }
  }
}
```

Pin a managed GitHub release server:

```json
{
  "servers": {
    "rust-analyzer": {
      "install": {
        "type": "github",
        "repo": "rust-lang/rust-analyzer",
        "version": "2026-05-25",
        "asset": "rust-analyzer-{platform}.gz",
        "bin": "rust-analyzer"
      }
    }
  }
}
```

Add a custom GitHub-release server:

```json
{
  "servers": {
    "example-ls": {
      "displayName": "Example Language Server",
      "filetypes": ["example"],
      "rootMarkers": [".git"],
      "install": {
        "type": "github",
        "repo": "example/example-ls",
        "version": "v1.2.3",
        "asset": "example-ls-linux-x64.tar.gz",
        "bin": "example-ls",
        "stripComponents": 1
      },
      "command": ["{installBin}/example-ls", "--stdio"],
      "settings": {},
      "initializationOptions": {},
      "lazy": true
    }
  }
}
```

Why configure this explicitly instead of symlinking Mason into Pi's managed directory?

- Ownership stays clear: Mason owns Mason installs; Pi owns `~/.pi/agent/lsp/`.
- `/lsp uninstall <serverId>` will not remove external binaries.
- `/lsp doctor <serverId>` can show the configured command directly.
- Broken or stale symlinks are avoided.

## Caching and pagination

List-like LSP tools return a first page instead of dumping every result into context. When more results exist, output includes a `resultId`:

```text
Showing 1-25 of 143.
More available: call lsp_more with resultId: lspres_...
```

Fetch the next page with:

```text
lsp_more({ resultId: "lspres_..." })
```

Cache behavior:

- Only multi-page results are cached.
- Pages are returned sequentially by `lsp_more`.
- Result IDs are session-local and in memory only.
- Cache budget defaults to 64 MB and 128 entries.
- Entries expire after 15 minutes of inactivity.
- Cache is cleared on reload, shutdown, and session replacement.
- Tool result details contain only the shown page, not the full result set.

## Commands

| Command                             | What it does                                                      |
| ----------------------------------- | ----------------------------------------------------------------- |
| `/lsp`                              | Open the interactive LSP panel, or show status in non-UI sessions |
| `/lsp status`                       | Print status as text                                              |
| `/lsp doctor`                       | Show config warnings and server details                           |
| `/lsp doctor <serverId>`            | Show resolved details for one server                              |
| `/lsp install <serverId[@version]>` | Install a managed language server                                 |
| `/lsp update <serverId[@version]>`  | Update/reinstall one managed server                               |
| `/lsp update --all`                 | Update all configured managed servers                             |
| `/lsp uninstall <serverId>`         | Remove Pi-managed install state and stop matching processes       |
| `/lsp start [serverId]`             | Start one installed server or all installed servers               |
| `/lsp restart [serverId]`           | Restart one installed server or all installed servers             |
| `/lsp stop [serverId]`              | Stop tracked LSP processes                                        |

Interactive `/lsp` panel keys:

```text
↑↓ select • enter doctor • i install • u update • x uninstall • s stop • r refresh • esc close
```

## How it works

- The extension adds read-only LSP tools and prompt guidance to Pi.
- File requests are resolved by filetype and nearest project root marker.
- Server definitions come from the built-in catalog plus global/project config.
- Missing-server behavior follows `installMode`; read warmup never installs missing servers.
- Servers start lazily over stdio and are tracked in a process registry.
- When `warmup` is enabled, source-file reads can prepare installed servers in the background before an LSP tool call.
- LSP responses are normalized into compact text plus structured details.
- Diagnostics, locations, and symbols are sorted/paged before reaching the model.
- Extra pages are stored in the in-memory result cache and fetched with `lsp_more`.
- The Pi status line shows active LSP servers, total configured servers, and warning count.

## Development

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
```

For local development with Pi:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfnT "$PWD" ~/.pi/agent/extensions/pi-lsp-adapter
pi
```

Run `/reload` in Pi after editing the extension.

## Release

Publishing is CI-driven. Do not create release tags by hand. To cut a release, make a normal commit that bumps `package.json` and `package-lock.json`; after that commit lands on `main` and CI passes, `.github/workflows/publish.yml` creates the matching semver tag and publishes to npm.

npm publishing uses Trusted Publishing for `.github/workflows/publish.yml`, so no npm token secret is required. The npm package must have a Trusted Publisher configured for `nikmmd/pi-lsp-adapter` and workflow filename `publish.yml`.

```bash
npm version 0.1.2 --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release v0.1.2"
git push origin main
```

Non-release pushes to `main` also trigger the publish workflow, but it exits without publishing when the current `package.json` version already exists on npm.

Stable versions such as `0.1.2` publish with the npm `latest` dist-tag. Prerelease versions such as `0.2.0-beta.1` publish with the npm `next` dist-tag.

## Troubleshooting

### `server is not installed`

Install it explicitly:

```text
/lsp install <serverId>
```

Or set global config to auto-install:

```json
{
  "installMode": "auto"
}
```

### Check the resolved command

```text
/lsp doctor <serverId>
```

This is the quickest way to see the final command, root markers, install state, and config warnings for one server.

### Reuse Mason.nvim servers

Configure the server as `type: "system"` in `~/.pi/agent/lsp.json` and point `command` at the Mason binary. Pi will use it but will not manage or uninstall it.

### Start fresh for one server

```text
/lsp stop <serverId>
/lsp uninstall <serverId>
/lsp install <serverId>
```

This only removes Pi-managed install state. It does not remove external system/Mason binaries configured with `type: "system"`.

## Limitations

- Tools are read-only. Rename, code action, and formatting support are intentionally not exposed yet.
- A language server must support the requested LSP capability for the matching tool to return data.
- First explicit LSP use can still be slower while a server starts, initializes, or installs, especially when warmup is disabled or the server was not installed when the file was read.
- `lsp_workspace_symbols` searches active clients by default; pass `serverId` to start/query a specific configured server.
- Files outside every workspace root cannot be queried until their project root is added; see [Files outside the workspace](#files-outside-the-workspace).
- Pagination result IDs are not persistent and can expire. Re-run the original LSP query if `lsp_more` says the cached result is gone.

## License

[MIT](https://opensource.org/license/MIT) © 2026 pi-lsp-adapter developers
