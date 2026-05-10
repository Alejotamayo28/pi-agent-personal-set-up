/**
 * Plan tracking utilities for Plan-Build mode.
 *
 * Extracts numbered plan steps from assistant messages,
 * tracks completion via [DONE:n] markers, and provides
 * a clean data model for the plan progress widget.
 *
 * Inspired by pi's built-in plan-mode example, adapted
 * for integration with subagent chains.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanItem {
  step: number;
  text: string;
  completed: boolean;
  /** Which agent will handle this step in BUILD mode */
  agent?: "reasoning" | "architect" | "coder" | "debugger" | "security" | "infra";
}

export interface PlanState {
  items: PlanItem[];
  /** Whether we are currently in plan-execution mode */
  executing: boolean;
  /** The original requirement that generated this plan */
  sourceTask?: string;
}

// ---------------------------------------------------------------------------
// Plan extraction
// ---------------------------------------------------------------------------

/**
 * Clean step text by removing markdown formatting and common prefixes.
 */
export function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
    .replace(/`([^`]+)`/g, "$1") // Remove inline code
    .replace(
      /^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  if (cleaned.length > 60) {
    cleaned = `${cleaned.slice(0, 57)}...`;
  }

  return cleaned;
}

/**
 * Detect which agent a plan step maps to based on keywords.
 */
export function detectAgentForStep(text: string): PlanItem["agent"] {
  const lower = text.toLowerCase();

  if (/implement|code|write|create|build|add\s+(logic|handler|endpoint|module)/i.test(lower)) {
    return "coder";
  }
  if (/test|debug|verify|check.*works|run.*test|qa/i.test(lower)) {
    return "debugger";
  }
  if (/security|audit|vulnerability|owasp|hardcoded|secret/i.test(lower)) {
    return "security";
  }
  if (/deploy|infra|terraform|kubernetes|docker|container|pipeline/i.test(lower)) {
    return "infra";
  }
  if (/design|architect|structure|layer|port|adapter|interface/i.test(lower)) {
    return "architect";
  }
  if (/analyz|plan|evaluate|approach|tradeoff|assess/i.test(lower)) {
    return "reasoning";
  }

  return undefined;
}

/**
 * Extract numbered plan items from an assistant message.
 * Looks for a "Plan:" section with numbered steps.
 */
export function extractPlanItems(message: string): PlanItem[] {
  const items: PlanItem[] = [];

  const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
  if (!headerMatch) return items;

  const planSection = message.slice(
    message.indexOf(headerMatch[0]) + headerMatch[0].length,
  );

  const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

  for (const match of planSection.matchAll(numberedPattern)) {
    const text = match[2].trim().replace(/\*{1,2}$/, "").trim();

    if (
      text.length > 5 &&
      !text.startsWith("`") &&
      !text.startsWith("/") &&
      !text.startsWith("-")
    ) {
      const cleaned = cleanStepText(text);
      if (cleaned.length > 3) {
        items.push({
          step: items.length + 1,
          text: cleaned,
          completed: false,
          agent: detectAgentForStep(cleaned),
        });
      }
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Completion tracking
// ---------------------------------------------------------------------------

/**
 * Extract [DONE:n] markers from a message.
 */
export function extractDoneSteps(message: string): number[] {
  const steps: number[] = [];
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

/**
 * Mark completed steps in a plan based on [DONE:n] markers in text.
 * Returns the number of newly completed steps.
 */
export function markCompletedSteps(
  text: string,
  items: PlanItem[],
): number {
  const doneSteps = extractDoneSteps(text);
  let newlyCompleted = 0;

  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step);
    if (item && !item.completed) {
      item.completed = true;
      newlyCompleted++;
    }
  }

  return newlyCompleted;
}

/**
 * Return only the remaining (uncompleted) steps.
 */
export function getRemainingSteps(items: PlanItem[]): PlanItem[] {
  return items.filter((item) => !item.completed);
}

/**
 * Summarize the current plan state for display or handoff.
 */
export function summarizePlan(items: PlanItem[]): string {
  if (items.length === 0) return "No plan items.";

  const completed = items.filter((i) => i.completed).length;
  const lines = items.map((item) => {
    const marker = item.completed ? "✓" : "○";
    const agentTag = item.agent ? ` [${item.agent}]` : "";
    return `${marker} ${item.step}. ${item.text}${agentTag}`;
  });

  return `Plan (${completed}/${items.length}):\n${lines.join("\n")}`;
}

/**
 * Build a compact plan summary to pass as {previous} to subagent chains.
 */
export function buildPlanHandoff(items: PlanItem[], sourceTask?: string): string {
  const remaining = getRemainingSteps(items);
  const lines = remaining.map((item) => {
    const agentTag = item.agent ? ` (${item.agent})` : "";
    return `${item.step}. ${item.text}${agentTag}`;
  });

  let handoff = "";
  if (sourceTask) handoff += `Task: ${sourceTask}\n`;
  handoff += `Remaining steps (${remaining.length}/${items.length}):\n`;
  handoff += lines.join("\n");

  return handoff;
}
