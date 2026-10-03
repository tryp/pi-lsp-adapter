import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { LspExtensionState } from "../state.js";
import { setLspStatusLine } from "../statusLine.js";

export type GetLspWarmupState = () => LspExtensionState | null;

export function registerLspWarmup(pi: ExtensionAPI, getState: GetLspWarmupState): void {
  pi.on("tool_call", (event, ctx) => {
    const state = getState();
    if (!state?.config.warmup) return;

    const isRead = isToolCallEventType("read", event);
    const isMutation =
      isToolCallEventType("edit", event) || isToolCallEventType("write", event);
    if (!isRead && !isMutation) return;

    const filePath = (event.input as { path?: string }).path;
    if (typeof filePath !== "string" || filePath.length === 0) return;

    // An edit to a file no client has opened yet has no auto-diag baseline, so
    // that edit goes unreported. Opening the document now means every later
    // edit to the same file has one. Fire-and-forget: the edit itself must not
    // wait for an LSP server to start.
    const warmupState = state;
    void warmupState.runtimeManager
      .warmupFile(filePath)
      .then((warmed) => {
        if (warmed && getState() === warmupState) setLspStatusLine(ctx, warmupState);
      })
      .catch(() => undefined);
  });
}
