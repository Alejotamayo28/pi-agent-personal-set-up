/**
 * Subagent launcher utilities for Plan-Build mode.
 *
 * Provides helper functions to construct task prompts for each
 * specialized agent and define the chain configurations for
 * plan-analysis (PLAN mode) and plan-execution (BUILD mode).
 *
 * These are NOT direct subagent invocations — they produce the
 * configuration objects that the LLM passes to the `subagent` tool
 * registered by pi-subagents.
 */

import type { PlanItem } from "./plan-tracker.js";
import { getRemainingSteps, buildPlanHandoff } from "./plan-tracker.js";

// ---------------------------------------------------------------------------
// Chain type definitions
// ---------------------------------------------------------------------------

export type PlanChainType =
  /** Analyze only — reasoning agent breaks down the problem */
  | "analyze"
  /** Analyze + design — reasoning → architect */
  | "design"
  /** Full plan — reasoning → architect, extract TODO items */
  | "full-plan"
  /** Execute an existing plan — coder → debugger → security */
  | "execute";

export interface ChainStep {
  agent: string;
  task: string;
  /** Optional output path for file-based handoff */
  output?: string;
}

export interface ChainConfig {
  steps: ChainStep[];
  /** Whether to use clarify mode (ask user before each step) */
  clarify: boolean;
  /** Context mode for subagent sessions */
  context: "fresh" | "fork";
}

// ---------------------------------------------------------------------------
// Task prompt builders
// ---------------------------------------------------------------------------

/**
 * Build a task prompt for the reasoning agent.
 * Short and focused — reasoning already knows its role from its agent .md.
 */
export function buildReasoningTask(userTask: string): string {
  return `Analizar: ${userTask}

Output: problem, constraints, decision, plan with numbered steps.
Max 300 words.`;
}

/**
 * Build a task prompt for the architect agent.
 * Receives reasoning output via {previous}.
 */
export function buildArchitectTask(userTask: string): string {
  return `Diseñar: ${userTask}
Basarse en el análisis de {previous}.
Usar arquitectura de .pi/context.md.
Output: archivos a crear/modificar, naming, instrucciones para coder.
Max 400 words.`;
}

/**
 * Build a task prompt for the coder agent.
 * Receives architect output via {previous}.
 */
export function buildCoderTask(
  userTask: string,
  planSummary: string,
): string {
  return `Implementar: ${userTask}
Plan: ${planSummary}
Seguir patrón de {previous}.
Implementar lógica completa, NO dejar "Not implemented".
Mark completed steps with [DONE:n].
Max 300 words.`;
}

/**
 * Build a task prompt for the debugger agent.
 * Receives coder output via {previous}.
 */
export function buildDebuggerTask(userTask: string): string {
  return `Testear: ${userTask}
Implementación: {previous}
Usar comandos de .pi/context.md.
Test endpoint/feature, report PASS/FAIL.
Max 300 words.`;
}

/**
 * Build a task prompt for the security agent.
 * Receives debugger output via {previous}.
 */
export function buildSecurityTask(userTask: string): string {
  return `Auditar: ${userTask}
Código: {previous}
Focus: OWASP Top 10.
Report findings by severity.
Max 300 words.`;
}

// ---------------------------------------------------------------------------
// Chain builders
// ---------------------------------------------------------------------------

/**
 * Build a chain configuration for plan-analysis in PLAN mode.
 *
 * - "analyze": reasoning only
 * - "design": reasoning → architect
 * - "full-plan": reasoning → architect (same as design, but caller extracts plan items)
 */
export function buildAnalysisChain(
  chainType: PlanChainType,
  userTask: string,
): ChainConfig {
  const steps: ChainStep[] = [];

  // Step 1: Always start with reasoning
  steps.push({
    agent: "reasoning",
    task: buildReasoningTask(userTask),
  });

  // Step 2: Add architect for design and full-plan
  if (chainType === "design" || chainType === "full-plan") {
    steps.push({
      agent: "architect",
      task: buildArchitectTask(userTask),
    });
  }

  return {
    steps,
    clarify: true,
    context: "fresh",
  };
}

/**
 * Build a chain configuration for plan-execution in BUILD mode.
 *
 * This produces the implementation chain: coder → debugger → security.
 * If only certain steps remain, it can skip agents whose steps are
 * all completed.
 */
export function buildExecutionChain(
  userTask: string,
  planItems: PlanItem[],
): ChainConfig {
  const remaining = getRemainingSteps(planItems);
  const needsCoder = remaining.some(
    (i) => !i.agent || i.agent === "coder" || i.agent === "architect",
  );
  const needsDebugger = remaining.some(
    (i) => i.agent === "debugger" || !i.agent,
  );
  const needsSecurity = remaining.some(
    (i) => i.agent === "security",
  );

  const planSummary = buildPlanHandoff(planItems);
  const steps: ChainStep[] = [];

  if (needsCoder) {
    steps.push({
      agent: "coder",
      task: buildCoderTask(userTask, planSummary),
    });
  }

  if (needsDebugger) {
    steps.push({
      agent: "debugger",
      task: buildDebuggerTask(userTask),
    });
  }

  if (needsSecurity) {
    steps.push({
      agent: "security",
      task: buildSecurityTask(userTask),
    });
  }

  // Ensure at least coder is in the chain (even for infra-only plans)
  if (steps.length === 0 && remaining.length > 0) {
    steps.push({
      agent: "coder",
      task: buildCoderTask(userTask, planSummary),
    });
    steps.push({
      agent: "debugger",
      task: buildDebuggerTask(userTask),
    });
  }

  return {
    steps,
    clarify: false,
    context: "fresh",
  };
}

// ---------------------------------------------------------------------------
// Chain to subagent() call format
// ---------------------------------------------------------------------------

/**
 * Convert a ChainConfig to the format expected by the `subagent` tool.
 * This is what gets passed as the parameters to `subagent({ chain: [...] })`.
 */
export function toSubagentChainParams(
  config: ChainConfig,
): {
  chain: Array<{ agent: string; task: string; output?: string }>;
  clarify: boolean;
  context: "fresh" | "fork";
} {
  return {
    chain: config.steps.map((step) => ({
      agent: step.agent,
      task: step.task,
      ...(step.output ? { output: step.output } : {}),
    })),
    clarify: config.clarify,
    context: config.context,
  };
}
