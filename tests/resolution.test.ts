/**
 * Module resolution tests for pi-lsp-adapter.
 *
 * Verifies that all npm packages used as bare imports by the extension
 * are resolvable via Node.js module resolution (both CJS require.resolve
 * and ESM import.meta.resolve).
 *
 * This catches the failure mode where pi's extension loader (jiti) cannot
 * resolve packages like vscode-uri because they are not in pi-core's
 * node_modules chain.
 *
 * Runs with: `npx tsx --test tests/resolution.test.ts`
 */

import { describe, it } from "node:test";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { resolve as pathResolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

// CJS require for module resolution (supports paths option)
const _require = createRequire(import.meta.url);

// ── Packages that pi-lsp-adapter imports as bare specifiers ─────────
// These are NOT in pi's VIRTUAL_MODULES and must be resolved via
// standard Node.js module resolution (node_modules traversal).
const BARE_IMPORTS_PI_LSP = [
	"vscode-uri",
	"vscode-jsonrpc/node.js",
	"vscode-languageserver-protocol",
	"vscode-languageserver-types",
];

// Packages that ARE in pi's VIRTUAL_MODULES but can also be resolved
// via node_modules (not just alias).
const VIRTUAL_BUNDLED = [
	"typebox",
	"typebox/value",
];

// The directory where pi's extension loader lives. Resolution from this
// directory must find all packages — this is exactly what pi's jiti loader
// does internally.
const PI_EXTENSIONS_DIR =
	"/home/dev/.pi/local/pi-coding-agent/dist/core/extensions";

// The extension's own source directory (for local resolution checks)
const EXT_SRC_DIR = pathResolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Try to resolve a package using CJS require.resolve with explicit paths.
 * Returns the resolved file path or null on failure.
 */
function tryResolve(specifier: string, searchPaths: string[]): string | null {
	try {
		return _require.resolve(specifier, { paths: searchPaths });
	} catch {
		return null;
	}
}

/**
 * Collect bare import specifiers from source files.
 * Returns { specifier, isTypeOnly } for each non-relative, non-node: import.
 */
function collectBareImports(
	dir: string,
): { specifier: string; isTypeOnly: boolean }[] {
	const results: { specifier: string; isTypeOnly: boolean }[] = [];
	const allowedPrefixes = ["node:", "./", "../"];

	function walk(d: string) {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const full = pathResolve(d, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
				walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
				const content = readFileSync(full, "utf-8");
				for (const line of content.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed.startsWith("import") && !trimmed.startsWith("export")) continue;
					const isTypeOnly = trimmed.startsWith("import type");
					const match = trimmed.match(/(?:from|import)\s+["']([^"']+)["']/);
					if (!match) continue;
					const specifier = match[1];
					if (allowedPrefixes.some((p) => specifier.startsWith(p))) continue;
					results.push({ specifier, isTypeOnly });
				}
			}
		}
	}

	walk(dir);
	return results;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("pi-lsp-adapter module resolution", () => {
	// ── From pi's extension loader directory ───────────────────────

	describe("from pi extension loader directory", () => {
		for (const pkg of BARE_IMPORTS_PI_LSP) {
			it(`resolves "${pkg}"`, () => {
				const resolved = tryResolve(pkg, [PI_EXTENSIONS_DIR]);
				assert.ok(
					resolved !== null,
					`"${pkg}" could not be resolved from ${PI_EXTENSIONS_DIR}\n` +
						`  This likely means the package symlink is missing from\n` +
						`  /home/dev/.pi/local/pi-coding-agent/node_modules/\n` +
						`  Run: make link-pi-deps`,
				);
				assert.ok(
					resolved!.endsWith(".js") ||
						resolved!.endsWith(".mjs") ||
						resolved!.endsWith(".cjs") ||
						resolved!.endsWith(".d.ts"),
					`resolved path "${resolved}" does not look like a module file`,
				);
			});
		}

		for (const pkg of VIRTUAL_BUNDLED) {
			it(`resolves bundled "${pkg}"`, () => {
				const resolved = tryResolve(pkg, [PI_EXTENSIONS_DIR]);
				assert.ok(
					resolved !== null,
					`"${pkg}" could not be resolved from ${PI_EXTENSIONS_DIR}`,
				);
			});
		}
	});

	// ── From the extension's source directory (always works) ───────

	describe("from extension source directory", () => {
		for (const pkg of BARE_IMPORTS_PI_LSP) {
			it(`resolves "${pkg}"`, () => {
				const resolved = tryResolve(pkg, [EXT_SRC_DIR]);
				assert.ok(
					resolved !== null,
					`"${pkg}" could not be resolved from ${EXT_SRC_DIR}\n` +
						`  Run: npm install in the pi-lsp-adapter directory`,
				);
			});
		}
	});
});

// ── Source file import audit ────────────────────────────────────────
// Verify that every bare import in the source matches our known list,
// so we don't silently miss a new dependency.

describe("source file import audit", () => {
	const KNOWN_BARE: string[] = [
		...BARE_IMPORTS_PI_LSP,
		...VIRTUAL_BUNDLED,
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-ai/oauth",
	];

	it("all bare imports in extension source files are accounted for", () => {
		const srcDir = pathResolve(EXT_SRC_DIR, "src");
		const discovered = new Set<string>();

		for (const { specifier, isTypeOnly } of collectBareImports(srcDir)) {
			// Skip type-only imports — they are erased at runtime
			if (isTypeOnly) continue;

			// Normalize to package-level name
			const bareName = specifier.startsWith("@")
				? specifier.split("/").slice(0, 2).join("/")
				: specifier;

			discovered.add(bareName);
		}

		// Find discovered imports not in the known list (exact match)
		const unknown = [...discovered].filter(
			(bare) => !KNOWN_BARE.includes(bare),
		);

		if (unknown.length > 0) {
			console.log(
				`\n  Unknown bare imports found (update KNOWN_BARE list):\n` +
					unknown.map((u) => `    - ${u}`).join("\n"),
			);
		}

		assert.equal(
			unknown.length, 0,
			`${unknown.length} unknown bare imports found in extension source`,
		);
	});
});
