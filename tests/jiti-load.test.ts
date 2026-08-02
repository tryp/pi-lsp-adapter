/**
 * Bare import resolution and Makefile symlink verification.
 *
 * Verifies that all npm packages used by the extension are resolvable
 * via standard Node.js module resolution, and that pi-core's node_modules
 * contains the required symlinks.
 *
 * This catches the "Cannot find module 'vscode-uri'" failure that occurs
 * when pi's extension loader cannot resolve a bare import.
 *
 * Runs with: `npx tsx --test tests/jiti-load.test.ts`
 */

import { describe, it } from "node:test";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, existsSync, lstatSync, readlinkSync } from "node:fs";
import { resolve as pathResolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const _require = createRequire(import.meta.url);

// ── Extension source directory ─────────────────────────────────────

const EXT_SRC = pathResolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
);

// ── Verify all bare imports are resolvable ─────────────────────────
// Instead of actually loading each file via jiti (which can be slow
// and prone to timeouts), we audit the bare import specifiers across
// the entire source tree and verify each one resolves via node_modules.

describe("bare import resolution", () => {
	it("all non-alias imports resolve from extension source directory", async () => {
		const errors: { specifier: string; file: string; }[] = [];

		for (const { specifier, file } of discoverBareImports()) {
			// Skip packages resolved via pi's alias mechanism
			if (specifier.startsWith("@earendil-works/")) {
				continue;
			}
			try {
				_require.resolve(specifier, { paths: [pathResolve(EXT_SRC, "..")] });
			} catch {
				errors.push({ specifier, file });
			}
		}

		if (errors.length > 0) {
			console.log(
				`\n  ${errors.length} unresolvable bare import(s):\n` +
					errors.map((e) => `    "${e.specifier}" in ${e.file}`).join("\n"),
			);
		}

		assert.equal(errors.length, 0,
			`${errors.length} unresolvable bare import(s) — run npm install`);
	});
});

// ── Makefile link-pi-deps verification ─────────────────────────────
// Tests that `make link-pi-deps` creates correct symlinks in pi-core's
// node_modules.

describe("Makefile link-pi-deps", () => {
	const PI_CORE_NM_PATH = "/home/dev/.pi/local/pi-coding-agent/node_modules";
	const REQUIRED_PKGS = [
		"vscode-uri",
		"vscode-jsonrpc",
		"vscode-languageserver-protocol",
		"vscode-languageserver-types",
	];

	for (const pkg of REQUIRED_PKGS) {
		it(`symlink exists for "${pkg}" in pi-core node_modules`, () => {
			const linkPath = pathResolve(PI_CORE_NM_PATH, pkg);

			const exists = existsSync(linkPath);
			assert.ok(exists, `Symlink missing: ${linkPath}\n  Run: make link-pi-deps`);

			if (exists) {
				const stat = lstatSync(linkPath);
				assert.ok(stat.isSymbolicLink(), `Not a symlink: ${linkPath}`);
				const target = readlinkSync(linkPath);
				assert.ok(
					target.startsWith("/home/dev/.pi/agent/npm/node_modules/"),
					`Symlink target mismatch:\n  expected: /home/dev/.pi/agent/npm/node_modules/${pkg}\n  actual: ${target}`,
				);
			}
		});
	}
});

// ── Helpers ─────────────────────────────────────────────────────────

interface BareImport { specifier: string; file: string; }

/**
 * Discover all bare import specifiers across the source tree.
 */
function discoverBareImports(): BareImport[] {
	const results: BareImport[] = [];
	const ALLOWED_PREFIXES = ["node:", "./", "../"];

	function walk(dir: string) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = pathResolve(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
				walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
				const content = readFileSync(full, "utf-8");
				for (const line of content.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed.startsWith("import") && !trimmed.startsWith("export")) continue;
					if (trimmed.startsWith("import type")) continue;
					const match = trimmed.match(/(?:from|import)\s+["']([^"']+)["']/);
					if (!match) continue;
					const specifier = match[1];
					const isInternal = ALLOWED_PREFIXES.some((p) => specifier.startsWith(p));
					if (isInternal) continue;
					results.push({ specifier, file: full });
				}
			}
		}
	}

	walk(EXT_SRC);
	return results;
}
