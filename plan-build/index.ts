/**
 * Plan-Build Mode Extension
 *
 * Two operational modes for safe coding agent sessions:
 *
 * PLAN mode -- read-only exploration & analysis. The agent CANNOT make any
 * file changes. Bash is restricted to read-only commands.
 * edit, write, and destructive bash are blocked.
 * Can delegate analysis to subagent chains (reasoning, architect).
 *
 * BUILD mode -- full access. The agent can read, edit, write, and run any
 * bash command without restrictions.
 * Can delegate implementation to subagent chains (coder, debugger, security).
 *
 * Inspired by OpenCode's Coder/Task agent split and Pi's plan-mode example,
 * redesigned as a clean two-mode safety toggle with subagent integration
 * for multi-agent planning and execution workflows.
 *
 * Switching:
 * /plan -> switch to PLAN mode
 * /build -> switch to BUILD mode
 * /mode -> interactive selector (plan / build)
 * /plan-with-agents -> run analysis chain in PLAN mode
 * /execute-plan -> run implementation chain in BUILD mode
 * Ctrl+Alt+M -> toggle between modes
 * --mode plan -> start in PLAN mode (CLI flag)
 *
 * Safety guarantees in PLAN mode (3-layer model):
 * - Layer 1 (Structural): edit/write tool calls are hard-blocked
 * - Layer 2 (Blocklist): obviously destructive bash commands are blocked
 * - Layer 3 (Prompt): system prompt instructs the LLM to only use read-only bash
 * - The mode is persisted in session entries so it survives /resume
 *
 * Subagent integration:
 * - PLAN mode: `plan_with_agents` tool delegates to reasoning → architect chains
 * - BUILD mode: `execute_plan` tool delegates to coder → debugger → security chains
 * - Plan progress tracking with [DONE:n] markers and visual widget
 * - Auto-detection: switching PLAN → BUILD with pending plan prompts execution
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { isBlockedCommand, findBlockedSegment } from "./utils.js";
import {
  type PlanItem,
  type PlanState,
  extractPlanItems,
  markCompletedSteps,
  getRemainingSteps,
  summarizePlan,
  buildPlanHandoff,
} from "./plan-tracker.js";
import {
  type PlanChainType,
  buildAnalysisChain,
  buildExecutionChain,
  toSubagentChainParams,
} from "./subagent-launcher.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Mode = "plan" | "build";

interface ModeState {
  mode: Mode;
}

interface PlanBuildState {
  mode: Mode;
  plan?: PlanState;
}

// ---------------------------------------------------------------------------
// Read-only tools available in PLAN mode
// Includes `subagent` so the agent can delegate analysis to reasoning/architect
// ---------------------------------------------------------------------------

const PLAN_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "plan_with_agents",
  "subagent",
];

const BUILD_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "execute_plan",
  "subagent",
];

// ---------------------------------------------------------------------------
// System prompt instructions per mode
// ---------------------------------------------------------------------------

const PLAN_SYSTEM_INSTRUCTION = `
[PLAN MODE -- READ-ONLY]

You are in PLAN mode. This is a read-only exploration and analysis mode.
Your job is to deeply understand the problem, explore the codebase, and
create a detailed implementation plan -- WITHOUT making any changes.

Hard restrictions (enforced by the system -- you literally cannot bypass these):
- You CANNOT use the edit tool. File modifications are disabled.
- You CANNOT use the write tool. Creating or overwriting files is disabled.
- Obviously destructive bash commands (rm, sudo, kill, git commit, npm install, etc.) are automatically blocked.

Self-imposed restrictions (you MUST obey these -- the system cannot check every bash variant):
- Only use bash for READ-ONLY operations: reading files, searching, listing directories, checking versions, inspecting processes/containers/infrastructure.
- NEVER run commands that modify the filesystem, install packages, change permissions, mutate git state, or alter system configuration.
- Be especially careful with:
  * Piped commands: do NOT pipe into destructive commands (e.g., cat f | sudo tee /etc/x)
  * Eval/subshell: do NOT use bash -c, sh -c, or $() to wrap destructive commands
  * Scripting: do NOT use python -c, node -e, perl -e, etc. to perform file writes or system mutations
  * Redirections: do NOT use >, >>, &> to write files
  * Editors: do NOT launch vim, nano, emacs, code, etc.

What you SHOULD do in PLAN mode:
- Read files thoroughly to get complete context.
- Use grep and find to explore related code and patterns.
- Understand the architecture before proposing solutions.
- Ask clarifying questions if requirements are ambiguous.
- Identify risks, edge cases, and dependencies.

SUBAGENT INTEGRATION IN PLAN MODE:
- You have access to the \`plan_with_agents\` tool and the \`subagent\` tool.
- Use \`plan_with_agents\` to delegate deep analysis to specialized agents:
  * chain_type "analyze" — reasoning agent analyzes the problem
  * chain_type "design" — reasoning → architect chain analyzes and designs
  * chain_type "full-plan" — reasoning → architect chain, then extract a numbered plan
- You can also use the \`subagent\` tool directly for custom delegation to reasoning or architect.
- Do NOT attempt to launch coder, debugger, or security agents in PLAN mode -- those are BUILD mode agents.

OUTPUT FORMAT -- Create a structured numbered plan:

Plan:
1. Step description -- what to change and why
2. Step description -- what to change and why
...

Files that will be modified:
...

Risks:
...

Tests to add/update:
...

When your plan is complete, tell the user to switch to BUILD mode (using /build or Ctrl+Alt+M)
or use /execute-plan to run the implementation chain. Do NOT attempt to make changes.
`.trim();

const BUILD_SYSTEM_INSTRUCTION = `
[BUILD MODE -- FULL ACCESS]

You are in BUILD mode. You have full access to read, edit, write, and bash tools.
You can make changes to the codebase.

Guidelines:
- Keep scope tight. Do exactly what was asked, no more.
- Read files before editing to understand current state.
- Make surgical edits. Prefer edit over write for existing files.
- Run tests or type checks after changes if the project has them.
- If you encounter unexpected complexity, STOP and explain rather than hacking around it.

SUBAGENT INTEGRATION IN BUILD MODE:
- You have access to the \`execute_plan\` tool and the \`subagent\` tool.
- If there is a pending plan, use \`execute_plan\` to delegate implementation to specialized agents:
  * coder → debugger → security chain executes the plan steps
- You can also use the \`subagent\` tool directly for custom delegation to any agent.
- After each step completes, mark it with [DONE:n] in your response (e.g., [DONE:1]).

PLAN EXECUTION TRACKING:
- When executing a plan, mark completed steps with [DONE:n] tags.
- The system tracks progress and updates the plan widget.
- After ALL steps are complete, the plan is automatically marked as done.

After completing changes:
- Summarize what was done.
- Note any follow-up work or tests that should be added.

If you need to explore or plan before making changes, suggest switching to PLAN mode
first (using /plan or Ctrl+Alt+M) or use /plan-with-agents for multi-agent analysis.
`.trim();

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function planBuildExtension(pi: ExtensionAPI): void {
  let currentMode: Mode = "build";
  let planItems: PlanItem[] = [];
  let planExecuting = false;
  let planSourceTask: string | undefined;

  // ------------------------------------------------------------------
  // CLI flag
  // ------------------------------------------------------------------

  pi.registerFlag("mode", {
    description: "Operational mode: plan (read-only) or build (full access)",
    type: "string",
    default: "",
  });

  // ------------------------------------------------------------------
  // Plan state management
  // ------------------------------------------------------------------

  function clearPlan(): void {
    planItems = [];
    planExecuting = false;
    planSourceTask = undefined;
  }

  function hasPendingPlan(): boolean {
    return planItems.length > 0 && getRemainingSteps(planItems).length > 0;
  }

  // ------------------------------------------------------------------
  // Mode switching logic
  // ------------------------------------------------------------------

  function switchToPlan(ctx: ExtensionContext): void {
    currentMode = "plan";
    // In PLAN mode, disable execute_plan (it's a BUILD tool)
    pi.setActiveTools(PLAN_TOOLS);
    updateStatus(ctx);
    persistState();
  }

  function switchToBuild(ctx: ExtensionContext): void {
    currentMode = "build";
    // In BUILD mode, disable plan_with_agents (it's a PLAN tool)
    pi.setActiveTools(BUILD_TOOLS);
    updateStatus(ctx);
    persistState();

    // Auto-detect pending plan and offer execution
    if (hasPendingPlan() && ctx.hasUI) {
      const remaining = getRemainingSteps(planItems);
      const stepList = remaining.map((i) => `  ${i.step}. ${i.text}`).join("\n");
      pi.sendMessage(
        {
          customType: "plan-build-pending",
          content: `📋 You have a pending plan with ${remaining.length} remaining step(s):\n${stepList}\n\nUse /execute-plan or the execute_plan tool to delegate implementation to coder → debugger → security agents.`,
          display: true,
        },
        { triggerTurn: false },
      );
    }
  }

  function toggleMode(ctx: ExtensionContext): void {
    if (currentMode === "plan") {
      switchToBuild(ctx);
    } else {
      switchToPlan(ctx);
    }
  }

  // ------------------------------------------------------------------
  // Status & widget
  // ------------------------------------------------------------------

  function updateStatus(ctx: ExtensionContext): void {
    const completed = planItems.filter((t) => t.completed).length;
    const modeLabel = currentMode === "plan" ? "📝PLAN" : "🔨BUILD";
    // Both modes use the same color (BUILD color)
    const modeColor = "success";

    if (planItems.length > 0) {
      // Always show mode + progress when there's a plan
      const planIcon = planExecuting ? "📋" : "⏳";
      ctx.ui.setStatus(
        "plan-build",
        ctx.ui.theme.fg(modeColor, modeLabel) + " " +
        ctx.ui.theme.fg("accent", `${planIcon} ${completed}/${planItems.length}`),
      );
    } else {
      // No plan, just show mode
      ctx.ui.setStatus(
        "plan-build",
        ctx.ui.theme.fg(modeColor, modeLabel),
      );
    }

    // Widget showing plan progress
    if (planItems.length > 0) {
      const lines = planItems.map((item) => {
        // Both completed and pending use same accent color
        const checkMark = ctx.ui.theme.fg("accent", item.completed ? "☑ " : "☐ ");
        if (item.completed) {
          return checkMark + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text));
        }
        const agentTag = item.agent ? ` [${item.agent}]` : "";
        return checkMark + item.text + ctx.ui.theme.fg("dim", agentTag);
      });
      ctx.ui.setWidget("plan-todos", lines);
    } else {
      ctx.ui.setWidget("plan-todos", undefined);
    }
  }

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------

  function persistState(): void {
    const state: PlanBuildState = {
      mode: currentMode,
      plan:
        planItems.length > 0
          ? { items: planItems, executing: planExecuting, sourceTask: planSourceTask }
          : undefined,
    };
    pi.appendEntry("plan-build", state);
  }

  // ------------------------------------------------------------------
  // Custom tool: plan_with_agents (PLAN mode only)
  // ------------------------------------------------------------------

  pi.registerTool({
    name: "plan_with_agents",
    label: "Plan with Agents",
    description:
      "Delegate analysis to specialized subagent chains in PLAN mode. " +
      "Use 'analyze' for problem breakdown (reasoning only), " +
      "'design' for analysis + architecture (reasoning → architect), " +
      "'full-plan' for a complete numbered plan with design (reasoning → architect). " +
      "Only available in PLAN mode.",
    promptSnippet:
      "Delegate deep analysis to reasoning and architect subagent chains for structured planning",
    promptGuidelines: [
      "Use plan_with_agents in PLAN mode when the task is complex enough to benefit from multi-agent analysis.",
      "Use chain_type 'analyze' for quick problem breakdown, 'design' for architecture decisions, 'full-plan' for complete implementation plans.",
      "Do NOT use plan_with_agents in BUILD mode -- use execute_plan instead.",
    ],
    parameters: Type.Object({
      task: Type.String({
        description: "The task or requirement to analyze and plan for",
      }),
      chain_type: StringEnum(["analyze", "design", "full-plan"] as const, {
        description:
          "Chain depth: analyze=reasoning, design=reasoning→architect, full-plan=reasoning→architect+extract plan",
        default: "full-plan",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Guard: only works in PLAN mode
      if (currentMode !== "plan") {
        return {
          content: [
            {
              type: "text",
              text: "plan_with_agents is only available in PLAN mode. Switch to PLAN mode first with /plan or Ctrl+Alt+M.",
            },
          ],
          details: { error: "wrong_mode" },
        };
      }

      const chainType = params.chain_type ?? "full-plan";
      const userTask = params.task;

      // Build the chain configuration
      const chainConfig = buildAnalysisChain(
        chainType as PlanChainType,
        userTask,
      );
      const subagentParams = toSubagentChainParams(chainConfig);

      // Store the source task for plan tracking
      planSourceTask = userTask;

      // Return instructions for the LLM to invoke the subagent tool
      // We cannot directly call the subagent tool from here, but we can
      // tell the LLM what to do next.
      const chainDesc = chainConfig.steps
        .map((s) => s.agent)
        .join(" → ");

      return {
        content: [
          {
            type: "text",
            text: [
              `Analysis chain configured: ${chainDesc}`,
              ``,
              `To execute this chain, call the subagent tool with:`,
              `\`\`\`json`,
              JSON.stringify(subagentParams, null, 2),
              `\`\`\``,
              ``,
              `After the chain completes, extract the numbered plan steps from the result.`,
              chainType === "full-plan"
                ? `The plan steps will be automatically tracked for progress when you switch to BUILD mode.`
                : ``,
            ].join("\n"),
          },
        ],
        details: {
          chainType,
          chainConfig: subagentParams,
          task: userTask,
        },
      };
    },
  });

  // ------------------------------------------------------------------
  // Custom tool: execute_plan (BUILD mode only)
  // ------------------------------------------------------------------

  pi.registerTool({
    name: "execute_plan",
    label: "Execute Plan",
    description:
      "Delegate plan execution to specialized subagent chains in BUILD mode. " +
      "Launches coder → debugger → security chain to implement, test, and audit the plan. " +
      "Mark completed steps with [DONE:n] tags. Only available in BUILD mode.",
    promptSnippet:
      "Delegate implementation to coder-debugger-security subagent chains for plan execution",
    promptGuidelines: [
      "Use execute_plan in BUILD mode to delegate plan implementation to coder → debugger → security agents.",
      "execute_plan tracks progress automatically via [DONE:n] markers in agent responses.",
      "Do NOT use execute_plan in PLAN mode -- use plan_with_agents instead.",
    ],
    parameters: Type.Object({
      task: Type.String({
        description: "The original task/requirement that the plan addresses",
      }),
      plan: Type.Optional(Type.String({
        description: "The plan to execute. If not provided, uses the current pending plan.",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Guard: only works in BUILD mode
      if (currentMode !== "build") {
        return {
          content: [
            {
              type: "text",
              text: "execute_plan is only available in BUILD mode. Switch to BUILD mode first with /build or Ctrl+Alt+M.",
            },
          ],
          details: { error: "wrong_mode" },
        };
      }

      const userTask = params.task;

      // Parse plan items from the provided plan text, or use existing plan
      if (params.plan) {
        const extracted = extractPlanItems(params.plan);
        if (extracted.length > 0) {
          planItems = extracted;
          planSourceTask = userTask;
        }
      }

      if (planItems.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No plan to execute. Create a plan first using /plan-with-agents in PLAN mode, or provide a plan in the 'plan' parameter with a numbered 'Plan:' section.",
            },
          ],
          details: { error: "no_plan" },
        };
      }

      // Enter execution mode
      planExecuting = true;
      updateStatus(ctx);
      persistState();

      // Build the execution chain
      const chainConfig = buildExecutionChain(userTask, planItems);
      const subagentParams = toSubagentChainParams(chainConfig);

      const chainDesc = chainConfig.steps
        .map((s) => s.agent)
        .join(" → ");
      const planSummary = summarizePlan(planItems);

      return {
        content: [
          {
            type: "text",
            text: [
              `Execution chain configured: ${chainDesc}`,
              ``,
              `Current plan status:`,
              planSummary,
              ``,
              `To execute this chain, call the subagent tool with:`,
              `\`\`\`json`,
              JSON.stringify(subagentParams, null, 2),
              `\`\`\``,
              ``,
              `After each step completes, mark it with [DONE:n] in your response.`,
              `Example: [DONE:1] after completing step 1.`,
            ].join("\n"),
          },
        ],
        details: {
          planItems: planItems.length,
          remaining: getRemainingSteps(planItems).length,
          chainConfig: subagentParams,
          task: userTask,
        },
      };
    },
  });

  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------

  pi.registerCommand("plan", {
    description: "Switch to PLAN mode (read-only, no file changes allowed)",
    handler: async (_args, ctx) => {
      if (currentMode === "plan") {
        ctx.ui.notify("Already in PLAN mode", "info");
        return;
      }
      switchToPlan(ctx);
    },
  });

  pi.registerCommand("build", {
    description: "Switch to BUILD mode (full access, file changes allowed)",
    handler: async (_args, ctx) => {
      if (currentMode === "build") {
        ctx.ui.notify("Already in BUILD mode", "info");
        return;
      }
      switchToBuild(ctx);
    },
  });

  pi.registerCommand("mode", {
    description: "Switch between PLAN and BUILD modes",
    handler: async (_args, ctx) => {
      const choices = [
        "PLAN -- read-only, analysis + subagent planning",
        "BUILD -- full access, implementation + subagent execution",
      ];
      const choice = await ctx.ui.select("Select mode:", choices);
      if (!choice) return;
      if (choice.startsWith("PLAN")) {
        if (currentMode !== "plan") switchToPlan(ctx);
      } else {
        if (currentMode !== "build") switchToBuild(ctx);
      }
    },
  });

  pi.registerCommand("plan-with-agents", {
    description:
      "Run analysis chain (reasoning → architect) in PLAN mode to create a structured plan",
    getArgumentCompletions: (prefix: string) => {
      const types = ["analyze", "design", "full-plan"];
      const filtered = types.filter((t) => t.startsWith(prefix));
      return filtered.length > 0
        ? filtered.map((t) => ({ value: t, label: t }))
        : null;
    },
    handler: async (args, ctx) => {
      if (currentMode !== "plan") {
        ctx.ui.notify(
          "plan-with-agents only works in PLAN mode. Switching to PLAN first.",
          "warning",
        );
        switchToPlan(ctx);
      }

      const chainType = args?.trim() || "full-plan";

      if (!["analyze", "design", "full-plan"].includes(chainType)) {
        ctx.ui.notify(
          `Invalid chain type: ${chainType}. Use: analyze, design, or full-plan`,
          "error",
        );
        return;
      }

      // Ask the user for the task
      const task = await ctx.ui.input(
        "What do you want to plan?",
        "Describe the feature, bug fix, or change...",
      );

      if (!task?.trim()) {
        ctx.ui.notify("No task provided. Aborting.", "warning");
        return;
      }

      // Store the source task
      planSourceTask = task.trim();

      // Build and display the chain config
      const chainConfig = buildAnalysisChain(
        chainType as PlanChainType,
        task.trim(),
      );
      const subagentParams = toSubagentChainParams(chainConfig);
      const chainDesc = chainConfig.steps.map((s) => s.agent).join(" → ");

      ctx.ui.notify(`🚀 Launching analysis chain: ${chainDesc}`, "info");

      // Send as a user message to trigger the agent to use the subagent tool
      pi.sendUserMessage(
        `Use the subagent tool to run this analysis chain for: "${task.trim()}"\n\n` +
          `Chain: ${chainDesc}\n` +
          `Parameters:\n\`\`\`json\n${JSON.stringify(subagentParams, null, 2)}\n\`\`\``,
        { deliverAs: "steer" },
      );
    },
  });

  pi.registerCommand("execute-plan", {
    description:
      "Run implementation chain (coder → debugger → security) in BUILD mode to execute a pending plan",
    handler: async (_args, ctx) => {
      if (currentMode !== "build") {
        ctx.ui.notify(
          "execute-plan only works in BUILD mode. Switching to BUILD first.",
          "warning",
        );
        switchToBuild(ctx);
      }

      if (!hasPendingPlan()) {
        // Ask the user to provide the plan
        const planText = await ctx.ui.editor(
          "No pending plan. Paste or write a plan (must have a 'Plan:' section with numbered steps):",
          "",
        );

        if (!planText?.trim()) {
          ctx.ui.notify("No plan provided. Aborting.", "warning");
          return;
        }

        const extracted = extractPlanItems(planText);
        if (extracted.length === 0) {
          ctx.ui.notify(
            "Could not extract plan steps. Make sure your plan has a 'Plan:' header with numbered steps (1. 2. 3. ...).",
            "error",
          );
          return;
        }

        planItems = extracted;
      }

      // Ask for the task if we don't have one
      if (!planSourceTask) {
        const task = await ctx.ui.input(
          "What task does this plan address?",
          "Describe the requirement...",
        );
        planSourceTask = task?.trim() || "Implementation task";
      }

      // Enter execution mode
      planExecuting = true;
      updateStatus(ctx);
      persistState();

      // Build and display the chain config
      const chainConfig = buildExecutionChain(planSourceTask, planItems);
      const subagentParams = toSubagentChainParams(chainConfig);
      const chainDesc = chainConfig.steps.map((s) => s.agent).join(" → ");
      const planSummary = summarizePlan(planItems);

      ctx.ui.notify(`🚀 Launching execution chain: ${chainDesc}`, "info");

      // Send as a user message to trigger the agent to use the subagent tool
      pi.sendUserMessage(
        `Execute the following plan using the subagent tool.\n\n` +
          `Current plan:\n${planSummary}\n\n` +
          `Chain: ${chainDesc}\n` +
          `Parameters:\n\`\`\`json\n${JSON.stringify(subagentParams, null, 2)}\n\`\`\`\n\n` +
          `After each step, mark completion with [DONE:n].`,
        { deliverAs: "steer" },
      );
    },
  });

  pi.registerCommand("todos", {
    description: "Show current plan progress",
    handler: async (_args, ctx) => {
      if (planItems.length === 0) {
        ctx.ui.notify(
          "No plan items. Create a plan first with /plan-with-agents",
          "info",
        );
        return;
      }

      const list = summarizePlan(planItems);
      ctx.ui.notify(list, "info");
    },
  });

  // ------------------------------------------------------------------
  // Keyboard shortcut: Ctrl+Alt+M to toggle
  // ------------------------------------------------------------------

  pi.registerShortcut(Key.ctrlAlt("m"), {
    description: "Toggle between PLAN and BUILD modes",
    handler: async (ctx) => toggleMode(ctx),
  });

  // ------------------------------------------------------------------
  // Safety: Layer 1 + Layer 2 in PLAN mode
  // ------------------------------------------------------------------

  pi.on("tool_call", async (event) => {
    if (currentMode !== "plan") return undefined;

    // Layer 1: Block edit and write tools entirely
    if (event.toolName === "edit" || event.toolName === "write") {
      return {
        block: true,
        reason: `PLAN mode: ${event.toolName} is disabled. Use /build or Ctrl+Alt+M to switch to BUILD mode before making changes.`,
      };
    }

    // Block execute_plan in PLAN mode (it's a BUILD-only tool)
    if (event.toolName === "execute_plan") {
      return {
        block: true,
        reason: `PLAN mode: execute_plan is a BUILD mode tool. Switch to BUILD mode first with /build or Ctrl+Alt+M.`,
      };
    }

    // Layer 2: Block obviously destructive bash commands via blocklist
    if (event.toolName === "bash") {
      const command = event.input.command as string;

      // Check the whole command first
      if (isBlockedCommand(command)) {
        return {
          block: true,
          reason: `PLAN mode: bash command blocked (destructive operation detected).\nCommand: ${command}\n\nUse /build or Ctrl+Alt+M to switch to BUILD mode before running destructive commands.`,
        };
      }

      // Also check each pipe segment individually
      const blockedSegment = findBlockedSegment(command);
      if (blockedSegment) {
        return {
          block: true,
          reason: `PLAN mode: bash command blocked (destructive pipe segment: "${blockedSegment}").\nCommand: ${command}\n\nUse /build or Ctrl+Alt+M to switch to BUILD mode before running destructive commands.`,
        };
      }
    }

    return undefined;
  });

  // ------------------------------------------------------------------
  // Block plan_with_agents in BUILD mode
  // ------------------------------------------------------------------

  pi.on("tool_call", async (event) => {
    if (currentMode !== "build") return undefined;

    if (event.toolName === "plan_with_agents") {
      return {
        block: true,
        reason: `BUILD mode: plan_with_agents is a PLAN mode tool. Switch to PLAN mode first with /plan or Ctrl+Alt+M.`,
      };
    }

    return undefined;
  });

  // ------------------------------------------------------------------
  // Layer 3: Inject mode-specific system prompt instructions
  // ------------------------------------------------------------------

  pi.on("before_agent_start", async (event) => {
    const instruction =
      currentMode === "plan" ? PLAN_SYSTEM_INSTRUCTION : BUILD_SYSTEM_INSTRUCTION;

    let extraContext = "";

    // Add pending plan context if available
    if (planItems.length > 0) {
      const planSummary = summarizePlan(planItems);
      if (currentMode === "plan") {
        extraContext += `\n\n[EXISTING PLAN]\nYou have an existing plan:\n${planSummary}\nYou can refine it or create a new one.`;
      } else if (currentMode === "build" && planExecuting) {
        const handoff = buildPlanHandoff(planItems, planSourceTask);
        extraContext += `\n\n[PLAN EXECUTION IN PROGRESS]\n${handoff}\nMark completed steps with [DONE:n].`;
      } else if (currentMode === "build" && hasPendingPlan()) {
        extraContext += `\n\n[PENDING PLAN]\nYou have a pending plan:\n${planSummary}\nUse execute_plan tool or /execute-plan to delegate implementation.`;
      }
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${instruction}${extraContext}`,
    };
  });

  // ------------------------------------------------------------------
  // Track plan progress after each turn
  // ------------------------------------------------------------------

  pi.on("turn_end", async (event, ctx) => {
    if (!planExecuting || planItems.length === 0) return;

    // Check for [DONE:n] markers in assistant messages
    const message = event.message as { role?: string; content?: unknown };
    if (message?.role !== "assistant") return;

    // Improved: extract ALL text content, including from thinking blocks
    let text = "";
    if (typeof message.content === "string") {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      text = message.content
        .filter((block) => typeof block === "object" && block !== null)
        .map((block) => {
          const b = block as { type?: string; text?: string; thinking?: string };
          // Include both text and thinking content
          return (b.text ?? "") + (b.thinking ?? "");
        })
        .join("\n");
    }

    const newlyCompleted = markCompletedSteps(text, planItems);
    if (newlyCompleted > 0) {
      updateStatus(ctx);
      persistState();

      // Check if all steps are complete
      if (planItems.every((i) => i.completed)) {
        pi.sendMessage(
          {
            customType: "plan-complete",
            content: `**Plan Complete!** ✓ All ${planItems.length} steps done.`,
            display: true,
          },
          { triggerTurn: false },
        );
        planExecuting = false;
        clearPlan();
        updateStatus(ctx);
        persistState();
      }
    }
  });

  // ------------------------------------------------------------------
  // Extract plan items from assistant messages after agent ends
  // ------------------------------------------------------------------

  pi.on("agent_end", async (event, ctx) => {
    // Only extract plans in PLAN mode when not already executing
    if (currentMode !== "plan" || planExecuting) return;
    if (!ctx.hasUI) return;

    // Find the last assistant message
    const messages = event.messages as Array<{
      role?: string;
      content?: unknown;
    }>;
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");

    if (!lastAssistant) return;

    let text = "";
    if (typeof lastAssistant.content === "string") {
      text = lastAssistant.content;
    } else if (Array.isArray(lastAssistant.content)) {
      text = lastAssistant.content
        .filter(
          (block) => typeof block === "object" && block !== null,
        )
        .map((block) => {
          const b = block as { type?: string; text?: string; thinking?: string };
          return (b.text ?? "") + (b.thinking ?? "");
        })
        .join("\n");
    }

    const extracted = extractPlanItems(text);
    if (extracted.length > 0) {
      planItems = extracted;
      updateStatus(ctx);
      persistState();

      // Show the plan and offer execution options
      const planSummary = summarizePlan(planItems);
      pi.sendMessage(
        {
          customType: "plan-todo-list",
          content: `**Plan Steps (${planItems.length}):**\n\n${planSummary}`,
          display: true,
        },
        { triggerTurn: false },
      );

      if (ctx.hasUI) {
        const choice = await ctx.ui.select("Plan created — what next?", [
          "Switch to BUILD and execute the plan",
          "Stay in PLAN mode and refine",
          "Execute with /plan-with-agents for deeper analysis",
        ]);

        if (choice?.startsWith("Switch to BUILD")) {
          switchToBuild(ctx);
          // Auto-trigger execution
          pi.sendUserMessage(
            `Execute the plan using the execute_plan tool. Task: ${planSourceTask || "implementation"}`,
            { deliverAs: "steer" },
          );
        } else if (choice?.startsWith("Execute with")) {
          // Re-run analysis with full-plan depth
          pi.sendUserMessage(
            `/plan-with-agents full-plan`,
            { deliverAs: "steer" },
          );
        }
        // "Stay in PLAN mode" — do nothing
      }
    }
  });

  // ------------------------------------------------------------------
  // Filter out stale mode context from previous sessions when mode
  // changes (avoid confusing the model with old mode instructions)
  // ------------------------------------------------------------------

  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((m) => {
        const msg = m as { customType?: string };
        if (
          msg.customType === "plan-build-context" ||
          msg.customType === "plan-mode-context" ||
          msg.customType === "plan-execution-context" ||
          msg.customType === "plan-build-pending" ||
          msg.customType === "plan-todo-list" ||
          msg.customType === "plan-complete"
        ) {
          return false;
        }
        return true;
      }),
    };
  });

  // ------------------------------------------------------------------
  // Persist mode on each turn start
  // ------------------------------------------------------------------

  pi.on("turn_start", async () => {
    persistState();
  });

  // ------------------------------------------------------------------
  // Restore state on session start / resume
  // ------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    // Check CLI flag first
    const modeFlag = pi.getFlag("mode");
    if (modeFlag === "plan") {
      currentMode = "plan";
    } else if (modeFlag === "build") {
      currentMode = "build";
    } else {
      // Restore from persisted session state
      const entries = ctx.sessionManager.getEntries();
      const modeEntry = entries
        .filter(
          (e: { type: string; customType?: string }) =>
            e.type === "custom" && e.customType === "plan-build",
        )
        .pop() as { data?: PlanBuildState } | undefined;

      if (modeEntry?.data?.mode) {
        currentMode = modeEntry.data.mode;
      }

      // Restore plan state
      if (modeEntry?.data?.plan) {
        planItems = modeEntry.data.plan.items || [];
        planExecuting = modeEntry.data.plan.executing || false;
        planSourceTask = modeEntry.data.plan.sourceTask;
      }
    }

    // Apply the mode
    if (currentMode === "plan") {
      pi.setActiveTools(PLAN_TOOLS);
    } else {
      pi.setActiveTools(BUILD_TOOLS);
    }

    updateStatus(ctx);

    // Notify user of current mode on resume
    if (currentMode === "plan") {
      ctx.ui.notify("PLAN mode active (read-only)", "warning");
    } else {
      ctx.ui.notify("BUILD mode active (full access)", "success");
    }

    // If resuming with a pending plan, show status
    if (hasPendingPlan()) {
      const remaining = getRemainingSteps(planItems);
      ctx.ui.notify(
        `📋 Pending plan: ${remaining.length} step(s) remaining`,
        "info",
      );
    }
  });

  // ------------------------------------------------------------------
  // Persist on session shutdown too (for safety)
  // ------------------------------------------------------------------

  pi.on("session_shutdown", async () => {
    persistState();
  });
}
