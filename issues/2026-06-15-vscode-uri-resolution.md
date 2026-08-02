# vscode-uri Module Resolution Failure

## Overview

pi-lsp-adapter extension fails to load with:
```
Error: Failed to load extension "/home/dev/src/pi-lsp-adapter/src/index.ts":
Failed to load extension: Cannot find module 'vscode-uri'
Require stack:
- /home/dev/src/pi-lsp-adapter/src/lsp/runtimeManager.ts
```

## Root Cause

Pi's extension loader uses `jiti` to load TypeScript files. The jiti instance is
created with `alias` configuration (for Node.js/dev mode) that maps pi-ecosystem
packages to their dist locations. For packages NOT in the alias list, jiti falls
through to standard Node.js module resolution.

Standard resolution searches `node_modules` directories upward from the imported
file's location. The extension file at `~/src/pi-lsp-adapter/src/lsp/runtimeManager.ts`
resolves `vscode-uri` from `~/src/pi-lsp-adapter/node_modules/vscode-uri/` via
parent-directory traversal. This works under normal conditions.

However, jiti with `alias` resolves bare specifiers relative to the jiti
instance's parentURL (the extension loader's location), NOT the imported file's
location. The loader is at:
```
~/.pi/local/pi-coding-agent/dist/core/extensions/loader.js
```

The `node_modules` chain from the loader's location does NOT contain `vscode-uri`.
It IS present in pi's custom npm root at `~/.pi/agent/npm/node_modules/`, but
jiti does not search that path by default.

### Affected Packages

| Package | In pi's VIRTUAL_MODULES? | In pi-core's node_modules? |
|---------|-------------------------|---------------------------|
| `vscode-uri` | No | No (symlink added) |
| `vscode-jsonrpc` | No | No (symlink added) |
| `vscode-languageserver-protocol` | No | No (symlink added) |
| `vscode-languageserver-types` | No | No (symlink added) |
| `typebox` | Yes (in VIRTUAL_MODULES) | N/A |
| `@earendil-works/pi-*` | Yes (in VIRTUAL_MODULES) | N/A |

## Fix

### Short-term (applied)

Symlink each missing package from pi's custom npm root into pi-core's `node_modules`:

```bash
PI_NM=~/.pi/local/pi-coding-agent/node_modules
PI_AGENT_NM=~/.pi/agent/npm/node_modules
for pkg in vscode-uri vscode-jsonrpc vscode-languageserver-protocol vscode-languageserver-types; do
  ln -sfn "$PI_AGENT_NM/$pkg" "$PI_NM/$pkg"
done
```

This ensures the module is resolvable from the loader's `node_modules` chain.

A Makefile target `link-pi-deps` is provided to re-create these symlinks:

```bash
cd ~/src/pi-lsp-adapter && make link-pi-deps
```

### Long-term (recommended)

Add these packages to pi-mono's extension loader VIRTUAL_MODULES (for Bun binary
mode) and alias (for Node.js/dev mode) in:
```
packages/coding-agent/src/core/extensions/loader.ts
```

This would make the resolution explicit and not rely on node_modules traversal.
