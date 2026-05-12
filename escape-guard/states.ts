/**
 * Escape Guard - State Machine
 *
 * Manages the abort execution logic.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

/**
 * Abort states for type documentation
 */
export type AbortState = "idle" | "warning" | "pending-abort";

/**
 * Execute the abort action.
 * Calls ctx.abort() and shows confirmation.
 */
export function executeAbort(
  ctx: ExtensionContext,
  onComplete: () => void,
): void {
  ctx.ui.notify("🛑 Aborting model execution...", "error");
  ctx.abort();
  ctx.ui.notify("✅ Model aborted", "success");
  onComplete();
}
