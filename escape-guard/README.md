# Escape Guard Extension

Double-confirmation abort mechanism for pi coding agent.

## Overview

When you press **Ctrl+Q** during model execution, this extension adds a safety layer for aborting:

1. **First press** → Shows a warning notification
2. **Second press (within 3s)** → Confirms and aborts the model
3. **Timeout expires** → Silently resets, model continues

**Note:** Regular **Escape** is still available for immediate abort (built-in pi behavior). This extension adds a double-confirmation layer on top.

## Features

- **Simple double-press confirmation** — no visual clutter
- **Auto-reset** after timeout (silent)
- **Clean abort confirmation** after successful cancellation

## Installation

Place the `escape-guard/` directory in your extensions folder:

```bash
cp -r escape-guard ~/.pi/agent/extensions/
```

Enable by adding to your config or running with the extension flag:

```bash
pi --extension ~/.pi/agent/extensions/escape-guard/index.ts
```

## Configuration

Edit `escape-guard/index.ts` to change the timeout:

```typescript
const WARNING_TIMEOUT_MS = 3000; // Change to 5000 for 5 seconds
```

## Usage

| Action | Result |
|--------|--------|
| Press Ctrl+Q once | Warning notification shown |
| Press Ctrl+Q again (within 3s) | Model aborts |
| Wait 3 seconds | Silently resets, model continues |

## State Machine

```
 ┌─────────────────────────────────────────────┐
 │                                             │
 ▼                                             │
 idle ────[Ctrl+Q]───► warning ────[Ctrl+Q]───► pending-abort ───► idle
 │                       │
 └──[3s timeout]─────────┘
```

## Files

| File | Description |
|------|-------------|
| `index.ts` | Main extension entry point |
| `states.ts` | State machine logic (abort execution) |
| `escape-guard.test.ts` | Unit tests |

## Running Tests

```bash
cd ~/.pi/agent/extensions
npx tsx escape-guard/escape-guard.test.ts
```

## Notes

- The extension registers a global shortcut for **Ctrl+Q**
- Only works when the agent is actively running (not in idle state)
- **Escape** alone still works for immediate abort (built-in pi)
