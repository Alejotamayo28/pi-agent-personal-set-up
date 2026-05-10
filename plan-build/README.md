# Plan-Build Mode Extension

Two operational modes for Pi coding agent sessions:

- **PLAN mode** — read-only exploration & analysis. No file changes allowed.
  Can delegate analysis to subagent chains (reasoning → architect).
- **BUILD mode** — full access. Read, edit, write, and run any command.
  Can delegate implementation to subagent chains (coder → debugger → security).

## Usage

| Action | How |
|---|---|
| Switch to PLAN mode | `/plan` |
| Switch to BUILD mode | `/build` |
| Interactive selector | `/mode` |
| Toggle between modes | `Ctrl+Alt+M` |
| Start in PLAN mode | `pi --mode plan` |
| Run analysis chain | `/plan-with-agents [analyze\|design\|full-plan]` |
| Run execution chain | `/execute-plan` |
| Show plan progress | `/todos` |

## 3-Layer Safety Model (PLAN mode)

When PLAN mode is active, three layers protect against unintended changes:

### Layer 1: Structural (hard block)

The `edit` and `write` tools are **hard-blocked** at the extension API level.
The agent literally cannot call these tools regardless of what the LLM decides.

### Layer 2: Blocklist (regex)

A short list of ~30 regex patterns catches **obviously destructive** bash commands:
`rm`, `sudo`, `kill`, `git commit`, `npm install`, `docker run`, etc.
Also analyzes pipe segments individually (catches `cat f | sudo tee`).

This layer is intentionally minimal -- only commands that are **almost always**
destructive in any context. It avoids the false positives of the old allowlist
approach (e.g., `python3 -c "print(install_dir)"` being blocked because it
contained the word "install").

### Layer 3: Prompt (LLM instruction)

The system prompt explicitly instructs the LLM to only use read-only bash
commands in PLAN mode. This covers the cases that regex cannot:

- Piped destructive commands that don't match the blocklist
- `python -c`, `node -e`, `perl -e` with destructive payloads
- Subshells and command substitution
- Creative uses of nominally-safe commands

## Subagent Integration

### PLAN mode: Analysis chains

In PLAN mode, the agent can delegate deep analysis to specialized subagents:

| Chain type | Agents | Purpose |
|---|---|---|
| `analyze` | reasoning | Problem breakdown, tradeoff analysis |
| `design` | reasoning → architect | Analysis + architecture design |
| `full-plan` | reasoning → architect | Complete numbered plan with design |

**How to use:**
1. `/plan-with-agents full-plan` — prompts for a task, launches the chain
2. The `plan_with_agents` tool — the LLM can invoke it directly
3. The `subagent` tool — for custom delegation

After the analysis chain completes, the extension automatically extracts
numbered plan steps and presents them with a progress widget.

### BUILD mode: Execution chains

In BUILD mode, the agent can delegate implementation to specialized subagents:

| Chain | Agents | Purpose |
|---|---|---|
| Full execution | coder → debugger → security | Implement, test, audit |

**How to use:**
1. `/execute-plan` — launches the chain for the current pending plan
2. The `execute_plan` tool — the LLM can invoke it directly
3. Auto-detection — switching from PLAN → BUILD with a pending plan prompts execution

Progress is tracked via `[DONE:n]` markers in agent responses. The plan widget
shows ☐ for pending and ☑ for completed steps.

### Agent-Step Mapping

The extension automatically detects which agent should handle each plan step
based on keywords:

| Keywords | Agent |
|---|---|
| implement, code, write, create, build | coder |
| test, debug, verify, check | debugger |
| security, audit, vulnerability, owasp | security |
| deploy, infra, terraform, kubernetes | infra |
| design, architect, structure, layer | architect |
| analyze, plan, evaluate, tradeoff | reasoning |

## Mode-Specific Tools

| Tool | PLAN mode | BUILD mode | Description |
|---|---|---|---|
| `read`, `bash`, `grep`, `find`, `ls` | ✅ | ✅ | Core exploration tools |
| `edit`, `write` | ❌ | ✅ | File modification tools |
| `plan_with_agents` | ✅ | ❌ | Analysis chain launcher |
| `execute_plan` | ❌ | ✅ | Execution chain launcher |
| `subagent` | ✅ | ✅ | Direct subagent delegation |

## Persistence

The current mode AND plan state are persisted in session entries, so they survive:

- Multiple turns in a conversation
- Session resume (`/resume`)
- Session shutdown and restart

## Agent Model Alignment

The subagent chain uses models aligned with each agent's specialization:

| Agent | Model | Why |
|---|---|---|
| reasoning | nemotron-ultra-253b | Deep analysis needs large reasoning model |
| architect | nemotron-ultra-253b | Architecture design needs deep thinking |
| coder | deepseek-v3.2 | Code generation is DeepSeek's specialty |
| debugger | deepseek-v3.2 | Code review/debugging benefits from code model |
| security | nemotron-super-49b | Security audit needs reasoning, lighter than ultra |
| infra | glm5 | Infrastructure config, doesn't need heavy model |
| orchestrator | qwen3-coder-480b | Coordination, needs large context |

## Files

- `index.ts` — Extension entry point: commands, shortcuts, hooks, persistence, tools, subagent integration
- `utils.ts` — Blocklist patterns and `isBlockedCommand()` / `findBlockedSegment()`
- `plan-tracker.ts` — Plan item extraction, completion tracking, summarization
- `subagent-launcher.ts` — Chain builders and task prompt generators for each agent
- `utils.test.ts` — Unit tests for blocklist and plan tracker

## Running tests

```bash
npx tsx utils.test.ts
```
