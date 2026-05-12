/**
 * Escape Guard Extension
 *
 * Double-confirmation abort mechanism for pi coding agent.
 *
 * Flow:
 * 1. User presses Ctrl+Q during model execution
 * 2. Extension shows a warning notification
 * 3. If user presses Ctrl+Q again within 3 seconds → aborts the model
 * 4. If timeout expires → silently resets to idle
 *
 * States:
 * - idle: Normal state, waiting for Ctrl+Q
 * - warning: User pressed Ctrl+Q once, waiting for confirmation
 * - pending-abort: User confirmed abort, executing cancel
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { executeAbort } from "./states.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type State = "idle" | "warning" | "pending-abort";

let currentState: State = "idle";
let warningTimeoutId: ReturnType<typeof setTimeout> | null = null;

// Configurable timeout (ms)
const WARNING_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function escapeGuardExtension(pi: ExtensionAPI): void {
  // ------------------------------------------------------------------
  // Escape shortcut handler
  // ------------------------------------------------------------------
  pi.registerShortcut("ctrl+q", {
    description: "Escape Guard: press once for warning, twice to abort",
    handler: async (ctx) => {
      switch (currentState) {
        case "idle": {
          // No UI available, just abort directly
          if (!ctx.hasUI) {
            ctx.abort();
            return;
          }

          // Show warning and start timeout
          ctx.ui.notify(
            `⚠ Press Ctrl+Q again within ${Math.round(WARNING_TIMEOUT_MS / 1000)}s to abort`,
            "warning",
          );

          currentState = "warning";

          warningTimeoutId = setTimeout(() => {
            if (currentState === "warning") {
              currentState = "idle";
            }
            warningTimeoutId = null;
          }, WARNING_TIMEOUT_MS);
          break;
        }
        case "warning": {
          // Clear the timeout since we're about to abort
          if (warningTimeoutId) {
            clearTimeout(warningTimeoutId);
            warningTimeoutId = null;
          }

          // Execute abort
          currentState = "pending-abort";
          executeAbort(ctx, () => {
            currentState = "idle";
          });
          break;
        }
        case "pending-abort":
          // Already pending abort, ignore additional presses
          break;
      }
    },
  });

  // ------------------------------------------------------------------
  // Session lifecycle
  // ------------------------------------------------------------------
  pi.on("session_start", async () => {
    currentState = "idle";
    if (warningTimeoutId) {
      clearTimeout(warningTimeoutId);
      warningTimeoutId = null;
    }
  });

  pi.on("session_shutdown", async () => {
    if (warningTimeoutId) {
      clearTimeout(warningTimeoutId);
      warningTimeoutId = null;
    }
    currentState = "idle";
  });
}
