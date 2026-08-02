import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { LspExtensionState } from "./state.js";

interface StatusLineContext {
  ui: {
    theme: { fg: (name: ThemeColor, text: string) => string };
    setStatus: (key: string, value: string | undefined) => void;
  };
}

export function formatLspStatusLine(state: LspExtensionState): string {
  const activeClients = state.runtimeManager.activeClients();
  const activeIds = [...new Set(activeClients.map((client) => client.serverId))].sort();
  const total = Object.keys(state.config.catalog.servers).length;
  const warnings = state.config.warnings.length;
  const activePart = activeIds.length > 0 ? activeIds.join(", ") : "(none active)";
  return `LSP: ${activeIds.length}/${total} servers: ${activePart}${warnings > 0 ? `, ${warnings} warning(s)` : ""}`;
}

export function setLspStatusLine(ctx: StatusLineContext, state: LspExtensionState): void {
  const color: ThemeColor = state.config.warnings.length > 0 ? "warning" : "accent";
  ctx.ui.setStatus("lsp", ctx.ui.theme.fg(color, formatLspStatusLine(state)));
}
