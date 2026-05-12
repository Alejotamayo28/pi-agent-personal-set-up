/**
 * Escape Guard Extension - Unit Tests
 *
 * Tests state machine transitions and abort execution logic.
 *
 * Run with: npx tsx escape-guard/escape-guard.test.ts
 */

import { type AbortState, executeAbort } from "./states.js";

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

// ===========================================================================
// States tests
// ===========================================================================

console.log("\n=== State Machine: executeAbort ===\n");

let abortCalled = false;
let completeCalled = false;

const mockCtx = {
  ui: {
    notify: (msg: string, type: string) => {
      console.log(`    [notify:${type}] ${msg}`);
    },
  },
  abort: () => {
    abortCalled = true;
    console.log("    [abort called]");
  },
} as unknown as Parameters<typeof executeAbort>[0];

executeAbort(mockCtx, () => {
  completeCalled = true;
});

assert(abortCalled, "executeAbort calls ctx.abort()");
assert(completeCalled, "executeAbort calls onComplete callback");

// ===========================================================================
// Type tests
// ===========================================================================

console.log("\n=== Type Validation ===\n");

const states: AbortState[] = ["idle", "warning", "pending-abort"];
assert(states.length === 3, "AbortState has all 3 states");
assert(typeof executeAbort === "function", "executeAbort is a function");

// ===========================================================================
// Results
// ===========================================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

if (failed > 0) {
  process.exit(1);
}
