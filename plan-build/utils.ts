/**
 * Safety utilities for Plan-Build mode.
 *
 * isBlockedCommand() uses a short blocklist of obviously destructive
 * command patterns. This is Layer 2 of the 3-layer safety model:
 *
 *   Layer 1 (Structural): edit/write tools are hard-blocked (index.ts)
 *   Layer 2 (Blocklist):  obviously destructive bash commands (this file)
 *   Layer 3 (Prompt):     LLM is instructed to only use read-only bash
 *
 * Design: blocklist-first (not allowlist)
 * - Only ~30 patterns for commands that are ALWAYS destructive.
 * - Everything else is left to the LLM's prompt instructions (Layer 3).
 * - This eliminates false positives from over-broad regexes
 *   (e.g., /\binstall\b/ blocking "python3 -c 'print(install_dir)'").
 * - This acknowledges that bash is Turing-complete and no regex
 *   set can cover every destructive variant (pipes, subshells,
 *   python -c, node -e, etc.). The prompt handles those nuances.
 */

// ---------------------------------------------------------------------------
// Blocked command patterns -- any match means BLOCKED
//
// Only commands that are ALMOST ALWAYS destructive in any context.
// Commands that are sometimes safe but sometimes destructive (awk,
// sed, python -c, node -e, curl, etc.) are NOT here -- the system
// prompt handles those cases.
// ---------------------------------------------------------------------------
const BLOCKED_PATTERNS: RegExp[] = [
	// -- File removal / overwrite -------------------------------------------
	/\brm\s/i,
	/\brm$/i,
	/\brmdir\b/i,
	/\bshred\b/i,
	/\btruncate\b/i,
	/\bdd\s/i,
	/\bdd$/i,

	// -- File modification / creation ---------------------------------------
	/\bmv\s/i,
	/\bmv$/i,
	/\bcp\s/i,
	/\bcp$/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\btee\b/i,
	/\bln\s/i,
	/\bln$/i,

	// -- Permission changes -------------------------------------------------
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,

	// -- Redirections that write --------------------------------------------
	/(^|[^<])>(?!>)/,   // single > redirect
	/>>/,               // append redirect
	/\b&>/,             // redirect both stdout+stderr

	// -- System administration ----------------------------------------------
	/\bsudo\b/i,
	/\bkill\s/i,
	/\bkill$/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bpoweroff\b/i,
	/\bhalt\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable|mask|unmask)\b/i,
	/\bservice\s+\S+\s+(start|stop|restart)\b/i,

	// -- Git mutations ------------------------------------------------------
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag\s|init|clone|apply|am\b|format-patch|mv|rm)\b/i,
	/\bgit\s+branch\s+-[dD]\b/i,

	// -- Package managers (install/remove) ----------------------------------
	/\b(npm|yarn|pnpm)\s+(install|add|remove|uninstall|ci|link|publish|update|upgrade)\b/i,
	/\b(pip|pipx)\s+(install|uninstall)\b/i,
	/\buv\s+(pip\s+)?(install|uninstall)\b/i,
	/\bcargo\s+(install|uninstall)\b/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade|dist-upgrade)\b/i,
	/\b(dnf|yum)\s+(install|remove|update|upgrade)\b/i,
	/\bbrew\s+(install|uninstall|upgrade|tap)\b/i,
	/\bpacman\s+(-S|-R|-U|-Sy)\b/i,

	// -- Container / infra mutations ----------------------------------------
	/\bdocker\s+(run|exec|rm|rmi|stop|kill|restart|build|push|tag|compose)\b/i,
	/\bkubectl\s+(apply|create|delete|replace|patch|rollout|scale|expose)\b/i,
	/\bhelm\s+(install|upgrade|uninstall|delete)\b/i,
	/\bterraform\s+(apply|destroy|taint|untaint|import)\b/i,

	// -- Network mutations --------------------------------------------------
	/\bssh\s/i,
	/\bssh$/i,
	/\bscp\s/i,
	/\bscp$/i,
	/\brsync\s/i,
	/\brsync$/i,

	// -- Subshells that bypass inspection ------------------------------------
	/\bbash\s+-c\b/i,
	/\bsh\s+-c\b/i,
	/\bzsh\s+-c\b/i,

	// -- Download that writes to disk ---------------------------------------
	/\bwget\b(?!.*-O\s*-\s*$)/i,
	/\bcurl\b.*(-o|--output)\s+(?!-$)/i,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if the given command matches an obviously destructive
 * pattern from the blocklist.
 *
 * This is NOT a complete safety check -- it only catches commands that
 * are almost always destructive. The system prompt (Layer 3) handles
 * the rest (pipes, subshells, eval constructs, etc.).
 */
export function isBlockedCommand(command: string): boolean {
	return BLOCKED_PATTERNS.some((p) => p.test(command));
}

/**
 * Analyzes a bash command string for pipe chains and checks each
 * segment against the blocklist. This catches patterns like:
 *   cat file | sudo tee /etc/config
 *   echo data | dd of=file
 *
 * Returns the first blocked segment, or null if none are blocked.
 */
export function findBlockedSegment(command: string): string | null {
	// Split by pipe operators (but not || which is logical OR)
	const segments = command
		.split(/\|(?!\|)/)
		.map((s) => s.trim())
		.filter(Boolean);

	for (const segment of segments) {
		if (isBlockedCommand(segment)) {
			return segment;
		}
	}
	return null;
}
