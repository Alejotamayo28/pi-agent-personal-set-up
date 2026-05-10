/**
 * Unit tests for Plan-Build mode safety and plan tracking utilities.
 *
 * Run with: node --experimental-vm-modules utils.test.mjs
 * (after compiling utils.ts to utils.js)
 *
 * Or manually with tsx: npx tsx utils.test.ts
 */

import { isBlockedCommand, findBlockedSegment } from "./utils.js";
import {
  extractPlanItems,
  markCompletedSteps,
  cleanStepText,
  detectAgentForStep,
  summarizePlan,
  buildPlanHandoff,
  getRemainingSteps,
  type PlanItem,
} from "./plan-tracker.js";

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

function assertBlocked(cmd: string): void {
  assert(isBlockedCommand(cmd), `Blocked: ${cmd}`);
}

function assertAllowed(cmd: string): void {
  assert(!isBlockedCommand(cmd), `Allowed: ${cmd}`);
}

// ===========================================================================
// Layer 2: Blocklist tests (existing)
// ===========================================================================

console.log("\n=== Layer 2: Blocklist -- should be BLOCKED ===\n");

// File removal
assertBlocked("rm -rf /");
assertBlocked("rm file.txt");
assertBlocked("rmdir old_dir");
assertBlocked("shred secret.txt");
assertBlocked("truncate -s 0 log.txt");
assertBlocked("dd if=/dev/zero of=/dev/sda");

// File modification
assertBlocked("mv old.txt new.txt");
assertBlocked("cp src.txt dest.txt");
assertBlocked("mkdir new_dir");
assertBlocked("touch newfile.txt");
assertBlocked("tee output.txt");
assertBlocked("ln -s target link");

// Permissions
assertBlocked("chmod 755 script.sh");
assertBlocked("chown user:group file");
assertBlocked("chgrp group file");

// Redirections
assertBlocked("echo hello > file.txt");
assertBlocked("echo hello >> file.txt");
assertBlocked("echo hello &> file.txt");

// System admin
assertBlocked("sudo apt install nginx");
assertBlocked("kill 1234");
assertBlocked("pkill -f node");
assertBlocked("killall python");
assertBlocked("reboot");
assertBlocked("shutdown -h now");
assertBlocked("systemctl start nginx");
assertBlocked("service nginx restart");

// Git mutations
assertBlocked("git add .");
assertBlocked("git commit -m 'fix'");
assertBlocked("git push origin main");
assertBlocked("git pull origin main");
assertBlocked("git checkout -b feature");
assertBlocked("git merge develop");
assertBlocked("git rebase main");
assertBlocked("git reset --hard HEAD~1");
assertBlocked("git stash");
assertBlocked("git branch -d old-branch");

// Package managers
assertBlocked("npm install react");
assertBlocked("yarn add express");
assertBlocked("pnpm install lodash");
assertBlocked("pip install requests");
assertBlocked("pipx install black");
assertBlocked("cargo install ripgrep");
assertBlocked("apt install nginx");
assertBlocked("apt-get install nginx");
assertBlocked("dnf install nginx");
assertBlocked("yum install nginx");
assertBlocked("brew install nginx");
assertBlocked("pacman -S nginx");

// Container/infra mutations
assertBlocked("docker run -d nginx");
assertBlocked("docker exec -it container bash");
assertBlocked("docker rm container");
assertBlocked("kubectl apply -f deployment.yaml");
assertBlocked("helm install my-release chart");
assertBlocked("terraform apply");

// Network mutations
assertBlocked("ssh user@host");
assertBlocked("scp file user@host:/path");
assertBlocked("rsync -av src/ dest/");

// Subshells
assertBlocked("bash -c 'rm -rf /'");
assertBlocked("sh -c 'echo destructive'");

// Downloads
assertBlocked("wget http://example.com/file");
assertBlocked("curl -o file.txt http://example.com");

console.log("\n=== Layer 2: Blocklist -- should be ALLOWED ===\n");

// File inspection (read-only)
assertAllowed("cat file.txt");
assertAllowed("head -n 20 file.txt");
assertAllowed("tail -f log.txt");
assertAllowed("less file.txt");
assertAllowed("more file.txt");

// Search
assertAllowed("grep -r pattern src/");
assertAllowed("rg pattern src/");
assertAllowed("fd . -e ts");
assertAllowed("find . -name '*.ts'");

// Directory listing
assertAllowed("ls -la");
assertAllowed("tree src/");
assertAllowed("du -sh .");
assertAllowed("df -h");
assertAllowed("stat file.txt");
assertAllowed("file data.bin");

// Text processing
assertAllowed("wc -l file.txt");
assertAllowed("sort file.txt");
assertAllowed("uniq file.txt");
assertAllowed("diff a.txt b.txt");
assertAllowed("cut -d, -f1 file.csv");
assertAllowed("tr 'a-z' 'A-Z' < file.txt");
assertAllowed("jq '.name' data.json");
assertAllowed("awk '{print $1}' file.txt");
assertAllowed("sed -n '1,10p' file.txt");
assertAllowed("bat file.txt");

// System info
assertAllowed("pwd");
assertAllowed("echo hello");
assertAllowed("printf '%s' hello");
assertAllowed("env");
assertAllowed("uname -a");
assertAllowed("whoami");
assertAllowed("hostname");
assertAllowed("date");
assertAllowed("uptime");
assertAllowed("which node");
assertAllowed("whereis python");

// Process info
assertAllowed("ps aux");
assertAllowed("htop");
assertAllowed("free -h");
assertAllowed("lscpu");
assertAllowed("lsblk");

// Network info
assertAllowed("ip addr");
assertAllowed("ss -tlnp");
assertAllowed("netstat -tlnp");
assertAllowed("nslookup example.com");
assertAllowed("dig example.com");
assertAllowed("ping -c 3 example.com");
assertAllowed("traceroute example.com");
assertAllowed("curl http://example.com");

// Git read-only
assertAllowed("git status");
assertAllowed("git log --oneline -10");
assertAllowed("git diff HEAD~1");
assertAllowed("git show abc123");
assertAllowed("git branch");
assertAllowed("git remote -v");
assertAllowed("git blame file.txt");
assertAllowed("git reflog");

// Language version checks
assertAllowed("node --version");
assertAllowed("node -e \"console.log('test')\"");
assertAllowed("python3 --version");
assertAllowed("python3 -c \"import os; print(os.getcwd())\"");
assertAllowed("go version");
assertAllowed("rustc --version");
assertAllowed("java --version");

// Package info (read-only)
assertAllowed("npm list");
assertAllowed("npm view react version");
assertAllowed("npm outdated");
assertAllowed("yarn list");
assertAllowed("pip list");
assertAllowed("pip show requests");

// Container info (read-only)
assertAllowed("docker ps");
assertAllowed("docker images");
assertAllowed("docker logs container");
assertAllowed("docker inspect container");
assertAllowed("kubectl get pods");
assertAllowed("kubectl describe pod mypod");
assertAllowed("kubectl logs mypod");
assertAllowed("helm list");
assertAllowed("terraform plan");
assertAllowed("terraform show");
assertAllowed("terraform validate");

console.log("\n=== Pipe segment analysis ===\n");

// Destructive pipe should be caught
assert(
  findBlockedSegment("cat file.txt | sudo tee /etc/config") !== null,
  "Pipe with sudo tee should be blocked",
);
assert(
  findBlockedSegment("echo data | dd of=file") !== null,
  "Pipe with dd should be blocked",
);
assert(
  findBlockedSegment("grep pattern | xargs rm") !== null,
  "Pipe with rm should be blocked",
);

// Safe pipe should pass
assert(
  findBlockedSegment("cat file.txt | grep pattern") === null,
  "Pipe with grep should be allowed",
);
assert(
  findBlockedSegment("ps aux | grep node") === null,
  "Pipe with grep on ps should be allowed",
);
assert(
  findBlockedSegment("git log | head -5") === null,
  "Pipe with head should be allowed",
);

// False positive regression tests
assertAllowed("python3 -c \"import os; print(os.getcwd())\"");
assertAllowed("python3 -c \"print(install_dir)\"");
assertAllowed("node -e \"console.log(process.cwd())\"");
assertAllowed("echo 'install complete'");
assertAllowed("sum file.txt");
assertAllowed("subprocess.run(['ls'])");
assertAllowed("go version");
assertAllowed("go env");

// ===========================================================================
// Plan Tracker tests (new)
// ===========================================================================

console.log("\n=== Plan Tracker: extractPlanItems ===\n");

const samplePlan = `Here's my analysis.

Plan:
1. Create the Task entity in the domain layer
2. Implement the CreateTaskUseCase with validation
3. Add the REST controller with POST /task endpoint
4. Write integration tests for the endpoint
5. Security audit for input validation

Risks: Memory store is not persisted.`;

const items = extractPlanItems(samplePlan);
assert(items.length === 5, `Extract 5 plan items, got ${items.length}`);
assert(items[0]?.step === 1, "First item step is 1");
assert(items[0]?.text.length > 0, "First item has text");
assert(items[0]?.completed === false, "First item is not completed");

console.log("\n=== Plan Tracker: detectAgentForStep ===\n");

assert(
  detectAgentForStep("Implement the CreateTaskUseCase") === "coder",
  "Implement maps to coder",
);
assert(
  detectAgentForStep("Write integration tests") === "debugger",
  "Write tests maps to debugger",
);
assert(
  detectAgentForStep("Security audit for input validation") === "security",
  "Security audit maps to security",
);
assert(
  detectAgentForStep("Design the hexagonal architecture") === "architect",
  "Design maps to architect",
);
assert(
  detectAgentForStep("Analyze tradeoffs for the approach") === "reasoning",
  "Analyze maps to reasoning",
);
assert(
  detectAgentForStep("Deploy to Kubernetes cluster") === "infra",
  "Deploy maps to infra",
);

console.log("\n=== Plan Tracker: cleanStepText ===\n");

assert(
  cleanStepText("**Create** the `Task` entity") === "Create the Task entity",
  "Strips markdown formatting",
);
assert(
  cleanStepText("Run the tests to verify the endpoint works correctly in production environments")
    .endsWith("..."),
  "Truncates long text",
);
assert(
  cleanStepText("use the repository pattern for data access") ===
    "Repository pattern for data access",
  "Strips common verb prefix and capitalizes",
);

console.log("\n=== Plan Tracker: markCompletedSteps ===\n");

const testItems: PlanItem[] = [
  { step: 1, text: "Create entity", completed: false },
  { step: 2, text: "Implement use case", completed: false },
  { step: 3, text: "Add controller", completed: false },
];

const completedCount = markCompletedSteps(
  "Step 1 done [DONE:1]. Step 2 done [DONE:2].",
  testItems,
);
assert(completedCount === 2, `Marked 2 steps, got ${completedCount}`);
assert(testItems[0]?.completed === true, "Step 1 is completed");
assert(testItems[1]?.completed === true, "Step 2 is completed");
assert(testItems[2]?.completed === false, "Step 3 is NOT completed");

console.log("\n=== Plan Tracker: getRemainingSteps ===\n");

const remaining = getRemainingSteps(testItems);
assert(remaining.length === 1, `1 remaining step, got ${remaining.length}`);
assert(remaining[0]?.step === 3, "Remaining step is step 3");

console.log("\n=== Plan Tracker: summarizePlan ===\n");

const summary = summarizePlan(testItems);
assert(summary.includes("2/3"), "Summary shows 2/3 completed");
assert(summary.includes("✓"), "Summary shows checkmarks");
assert(summary.includes("○"), "Summary shows pending markers");

console.log("\n=== Plan Tracker: buildPlanHandoff ===\n");

const handoff = buildPlanHandoff(testItems, "Create REST API");
assert(handoff.includes("Task: Create REST API"), "Handoff includes task");
assert(handoff.includes("Remaining"), "Handoff includes remaining count");
assert(handoff.includes("Add controller"), "Handoff includes step text");

console.log("\n=== Plan Tracker: extractPlanItems edge cases ===\n");

// No Plan: header
assert(
  extractPlanItems("Just some text without a plan").length === 0,
  "No items when no Plan: header",
);

// Empty plan
assert(
  extractPlanItems("Plan:\n\nNo steps here.").length === 0,
  "No items for empty plan",
);

// Plan with *bold* header
const boldPlan = extractPlanItems("**Plan:**\n1. First step\n2. Second step");
assert(boldPlan.length === 2, `Bold header: 2 items, got ${boldPlan.length}`);

// Multiple [DONE:n] in same message
const multiDone: PlanItem[] = [
  { step: 1, text: "A", completed: false },
  { step: 2, text: "B", completed: false },
  { step: 3, text: "C", completed: false },
];
markCompletedSteps("[DONE:1] and [DONE:3] done", multiDone);
assert(multiDone[0]?.completed === true, "Multi-done: step 1");
assert(multiDone[1]?.completed === false, "Multi-done: step 2 not done");
assert(multiDone[2]?.completed === true, "Multi-done: step 3");

// Case insensitive [DONE:n]
const caseItems: PlanItem[] = [
  { step: 1, text: "A", completed: false },
];
markCompletedSteps("[done:1] lowercase", caseItems);
assert(caseItems[0]?.completed === true, "[done:1] is case-insensitive");

// ===========================================================================
// Results
// ===========================================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

if (failed > 0) {
  process.exit(1);
}
