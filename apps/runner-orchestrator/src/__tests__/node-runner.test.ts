import { describe, it } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

import {
  validateSubmissionFilePath,
  assembleNodeWorkspace,
  cleanupNodeWorkspace,
} from "../node-sandbox.js";
import {
  buildDockerRunArgs,
  runNodeChallenge,
} from "../node-runner.js";
import { isNodeChallenge } from "../job.js";
import { mapDriverOutcome } from "../result-mapper.js";
import { projectTestRunForViewer } from "../test-visibility.js";

// Paths to challenge fixtures
const FIXTURE_DIR = path.resolve(process.cwd(), "fixtures/challenge-001");
const JUDGE_DIR = path.resolve(process.cwd(), "fixtures/judge-tests/challenge-001");

// Valid reference student submission (from POC test-user)
const VALID_SERVER_JS = `
const express = require("express");
const productsData = require("./data/products");

const app = express();
app.use(express.json());

app.post("/api/products", (req, res) => {
  const { name, price, tags } = req.body || {};
  if (typeof name !== "string" || name.trim().length === 0 || typeof price !== "number" || !Number.isFinite(price)) {
    return res.status(400).json({ error: "Invalid product data" });
  }
  if (!Array.isArray(tags) || tags.length < 3) {
    return res.status(400).json({ error: "At least 3 tags are required" });
  }
  const product = productsData.create({ name, price, tags });
  return res.status(201).json(product);
});

app.get("/api/products", (req, res) => {
  return res.status(200).json(productsData.getAll());
});

app.get("/api/products/:id", (req, res) => {
  const product = productsData.getById(req.params.id);
  if (!product) {
    return res.status(404).json({ error: "Product not found" });
  }
  return res.status(200).json(product);
});

app.delete("/api/products/:id", (req, res) => {
  const deleted = productsData.remove(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: "Product not found" });
  }
  return res.status(200).json({ message: "Product deleted" });
});

module.exports = app;
`;

const VALID_PRODUCTS_JS = `
let products = [
  { id: "1", name: "Laptop", price: 999, tags: ["electronics", "computer", "work"] },
  { id: "2", name: "Mouse", price: 25, tags: ["electronics", "computer", "accessories"] },
  { id: "3", name: "Keyboard", price: 75, tags: ["electronics", "computer", "accessories"] },
];
let nextId = 4;

function getAll() { return products; }
function create(product) {
  const newProduct = { id: String(nextId++), name: product.name, price: product.price, tags: product.tags };
  products.push(newProduct);
  return newProduct;
}
function getById(id) { return products.find((product) => product.id === id); }
function remove(id) {
  const index = products.findIndex((product) => product.id === id);
  if (index === -1) return false;
  products.splice(index, 1);
  return true;
}
function reset() {
  products = [
    { id: "1", name: "Laptop", price: 999, tags: ["electronics", "computer", "work"] },
    { id: "2", name: "Mouse", price: 25, tags: ["electronics", "computer", "accessories"] },
    { id: "3", name: "Keyboard", price: 75, tags: ["electronics", "computer", "accessories"] },
  ];
  nextId = 4;
}
module.exports = { getAll, create, getById, remove, reset };
`;

// Student code that fails a VISIBLE test (e.g. doesn't require 3 tags)
const VISIBLE_FAIL_SERVER_JS = VALID_SERVER_JS.replace(
  `if (!Array.isArray(tags) || tags.length < 3)`,
  `if (!Array.isArray(tags) || tags.length < 0)`
);

// Student code that passes VISIBLE tests but fails HIDDEN tests
// (e.g. returns 200 instead of 404 when deleting a non-existent ID)
const HIDDEN_FAIL_SERVER_JS = VALID_SERVER_JS.replace(
  `if (!deleted) {\n    return res.status(404).json({ error: "Product not found" });\n  }`,
  `if (!deleted) {\n    return res.status(200).json({ message: "ignored" });\n  }`
);

// Student code that hangs indefinitely
const TIMEOUT_SERVER_JS = `
const express = require("express");
const app = express();
// Deliberate infinite busy loop on require/startup
while (true) {}
module.exports = app;
`;

describe("Tutly Node Runner V1 Pipeline", () => {
  // 1. Path traversal & security checks
  it("TEST 6: path traversal is strictly rejected", () => {
    assert.throws(
      () => validateSubmissionFilePath("../../etc/passwd"),
      /escapes workspace/,
    );
    assert.throws(
      () => validateSubmissionFilePath("../escape.js"),
      /escapes workspace/,
    );
    assert.throws(
      () => validateSubmissionFilePath("/etc/shadow"),
      /escapes workspace/,
    );
    assert.throws(
      () => validateSubmissionFilePath("backend/../../escape.js"),
      /escapes workspace/,
    );
    assert.throws(
      () => validateSubmissionFilePath("backend/\0evil.js"),
      /null byte/,
    );
  });

  // 2. Forbidden files & prefix protection
  it("TEST 7: forbidden evaluator-owned paths are rejected", () => {
    assert.throws(
      () => validateSubmissionFilePath("package.json"),
      /protected file/,
    );
    assert.throws(
      () => validateSubmissionFilePath("challenge.json"),
      /protected file/,
    );
    assert.throws(
      () => validateSubmissionFilePath("jest.config.js"),
      /protected file/,
    );
    assert.throws(
      () => validateSubmissionFilePath("__hidden__/exploit.test.js"),
      /protected path prefix/,
    );
    assert.throws(
      () => validateSubmissionFilePath("tests/overwrite.test.js"),
      /protected path prefix/,
    );
    assert.throws(
      () => validateSubmissionFilePath("node_modules/hack.js"),
      /protected path prefix/,
    );
    assert.throws(
      () => validateSubmissionFilePath(".git/config"),
      /protected path prefix/,
    );
  });

  // 3. Docker hardening arguments verification
  it("TEST 9: Docker container is invoked with required hardening arguments", () => {
    const args = buildDockerRunArgs({
      hostCwd: "/tmp/tutly-runner/run-test",
      containerName: "tutly-node-test-vis",
      testCommand: "npm test",
    });

    assert.ok(args.includes("--rm"), "must have --rm");
    assert.ok(args.includes("--network=none"), "must have --network=none");
    assert.ok(args.includes("--read-only"), "must have --read-only");
    assert.ok(
      args.some((a) => a.includes("/tmp:rw,noexec,nosuid")),
      "must have restricted tmpfs /tmp",
    );
    assert.ok(args.includes("--cap-drop=ALL"), "must drop ALL capabilities");
    assert.ok(
      args.includes("--security-opt=no-new-privileges"),
      "must prevent new privileges",
    );
    assert.ok(
      args.some((a) => a.startsWith("--memory=")),
      "must set memory cap",
    );
    assert.ok(
      args.some((a) => a.startsWith("--cpus=")),
      "must set CPU limit",
    );
    assert.ok(
      args.some((a) => a.startsWith("--pids-limit=")),
      "must set PIDs limit",
    );
    assert.ok(
      args.includes("/submission"),
      "must set workdir to /submission",
    );
  });

  // 4. Test workspace creation & cleanup
  it("TEST 10 & 11: workspace assembly and cleanup work cleanly", async () => {
    const ws = await assembleNodeWorkspace({
      testRunId: "test-cleanup-check",
      mode: "visible",
      submissionFiles: {
        "backend/server.js": "module.exports = {};",
      },
      challengeDir: FIXTURE_DIR,
    });

    assert.ok(existsSync(ws.cwd), "workspace must exist on disk");
    assert.ok(
      existsSync(path.join(ws.cwd, "backend/server.js")),
      "student file must be written",
    );
    assert.ok(
      existsSync(path.join(ws.cwd, "package.json")),
      "package.json must be injected",
    );
    assert.ok(
      !existsSync(path.join(ws.cwd, "__hidden__")),
      "__hidden__ must NOT exist in visible mode",
    );

    await cleanupNodeWorkspace(ws.cwd);
    assert.ok(!existsSync(ws.cwd), "workspace must be deleted after cleanup");
  });

  // 5. End-to-end: Valid student code passes Visible (4/4) and Hidden (8/8)
  it("TEST 1 & 2: Valid submission passes visible (4/4) and hidden (8/8)", async () => {
    const outcome = await runNodeChallenge({
      testRunId: "test-e2e-pass",
      submissionFiles: {
        "backend/server.js": VALID_SERVER_JS,
        "backend/data/products.js": VALID_PRODUCTS_JS,
      },
      challengeDir: FIXTURE_DIR,
      judgeTestsDir: JUDGE_DIR,
    });

    assert.strictEqual(outcome.kind, "completed");
    if (outcome.kind === "completed") {
      const { report } = outcome;
      assert.strictEqual(report.status, "PASSED");
      assert.strictEqual(report.visible.passed, 4, "Visible tests passed must be 4");
      assert.strictEqual(report.visible.total, 4, "Visible tests total must be 4");
      assert.strictEqual(report.visible.failed, 0, "Visible tests failed must be 0");

      assert.strictEqual(report.hidden.passed, 4, "Hidden tests passed must be 4");
      assert.strictEqual(report.hidden.total, 4, "Hidden tests total must be 4");
      assert.strictEqual(report.hidden.failed, 0, "Hidden tests failed must be 0");

      assert.strictEqual(
        report.results.length,
        8,
        "Combined results must contain exactly 8 tests (4 visible + 4 hidden)",
      );
    }
  });

  // 6. Visible failure detected
  it("TEST 3: Visible test failure is detected and reported as FAILED", async () => {
    const outcome = await runNodeChallenge({
      testRunId: "test-visible-fail",
      submissionFiles: {
        "backend/server.js": VISIBLE_FAIL_SERVER_JS,
        "backend/data/products.js": VALID_PRODUCTS_JS,
      },
      challengeDir: FIXTURE_DIR,
      judgeTestsDir: JUDGE_DIR,
    });

    assert.strictEqual(outcome.kind, "completed");
    if (outcome.kind === "completed") {
      const { report } = outcome;
      assert.strictEqual(report.status, "FAILED");
      assert.ok(report.visible.failed > 0, "Must have visible test failure");
    }
  });

  // 7. Hidden failure detected (visible passes, hidden fails, overall FAILED)
  it("TEST 4: Hidden test failure is detected when visible tests pass", async () => {
    const outcome = await runNodeChallenge({
      testRunId: "test-hidden-fail",
      submissionFiles: {
        "backend/server.js": HIDDEN_FAIL_SERVER_JS,
        "backend/data/products.js": VALID_PRODUCTS_JS,
      },
      challengeDir: FIXTURE_DIR,
      judgeTestsDir: JUDGE_DIR,
    });

    assert.strictEqual(outcome.kind, "completed");
    if (outcome.kind === "completed") {
      const { report } = outcome;
      assert.strictEqual(report.status, "FAILED", "Overall status must be FAILED");
      assert.strictEqual(
        report.visible.passed,
        4,
        "Visible tests should still pass 4/4",
      );
      assert.ok(
        report.hidden.failed > 0,
        "Hidden test suite must fail at least 1 test",
      );
    }
  });

  // 8. Server-side test visibility & participant projection (Hidden tests redacted)
  it("TEST 5: Hidden test source and details are NEVER visible to participants", () => {
    const dummyRun = {
      id: "run-123",
      submissionId: "sub-123",
      assignmentId: "asg-123",
      serviceConnectionId: null,
      provider: "LOCAL" as const,
      status: "FAILED" as const,
      trigger: "auto-submit",
      visiblePassed: 4,
      visibleTotal: 4,
      hiddenPassed: 3,
      hiddenTotal: 4,
      score: 7,
      maxScore: 10,
      outputSummary: {
        results: [
          {
            title: "tests/product.visible.test.js > creates a product",
            visibility: "VISIBLE",
            passed: true,
          },
          {
            title: "__hidden__/product.hidden.test.js > invalid product ID returns 404",
            visibility: "HIDDEN",
            passed: false,
            error: "expected 404 got 200",
          },
        ],
      },
      jestReport: { fullDetails: "secret server assertion code" },
      errorMessage: null,
      attempt: 1,
      triggeredByUserId: "student-1",
      logsArtifactId: "art-logs",
      reportArtifactId: "art-report",
      startedAt: new Date(),
      completedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // 1. Project for STUDENT (owner)
    const studentView = projectTestRunForViewer(
      dummyRun,
      { dueDate: null },
      { role: "STUDENT", isOwnerOfSubmission: true },
    );

    assert.strictEqual(studentView.jestReport, null, "Student must never receive jestReport");
    assert.strictEqual(studentView.hiddenPassed, 0, "Student hiddenPassed must be 0");
    assert.strictEqual(studentView.hiddenTotal, 0, "Student hiddenTotal must be 0");

    const studentResults = (studentView.outputSummary as any)?.results ?? [];
    assert.ok(
      studentResults.every((r: any) => r.visibility !== "HIDDEN"),
      "Student output must contain zero HIDDEN test entries",
    );
    assert.ok(
      !JSON.stringify(studentView).includes("__hidden__"),
      "Student payload must never mention __hidden__",
    );

    // 2. Project for INSTRUCTOR (staff)
    const instructorView = projectTestRunForViewer(
      dummyRun,
      { dueDate: null },
      { role: "INSTRUCTOR", isOwnerOfSubmission: false },
    );

    assert.ok(instructorView.jestReport !== null, "Instructor receives raw jestReport");
    assert.strictEqual(instructorView.hiddenPassed, 3, "Instructor sees actual hiddenPassed");
    assert.strictEqual(instructorView.hiddenTotal, 4, "Instructor sees actual hiddenTotal");
  });

  // 9. Timeout watchdog terminates hanging container
  it("TEST 8: Watchdog actively kills hanging container on timeout", async () => {
    const startTime = Date.now();
    const outcome = await runNodeChallenge({
      testRunId: "test-timeout-check",
      submissionFiles: {
        "backend/server.js": TIMEOUT_SERVER_JS,
        "backend/data/products.js": VALID_PRODUCTS_JS,
      },
      challengeDir: FIXTURE_DIR,
      timeoutMs: 3000, // 3s short timeout for test
    });

    const duration = Date.now() - startTime;
    assert.strictEqual(outcome.kind, "timeout", "Outcome must be timeout");
    assert.ok(duration < 10000, "Timeout must abort promptly without hanging");

    // Verify container was cleaned up
    const containerCheck = execSync(
      "docker ps -a --filter name=tutly-node-test-timeout-check --format '{{.Names}}'",
      { encoding: "utf8" },
    );
    assert.strictEqual(
      containerCheck.trim(),
      "",
      "Timed out container must be killed and removed",
    );
  });

  // 10. Existing browser runner mapper tests pass (Zero regressions)
  it("TEST 12: Existing browser runner result mapper functions without regressions", () => {
    const browserOutcome = mapDriverOutcome({
      ok: true,
      testsByPath: {
        "/src/App.test.js": [
          {
            name: "renders learn react link",
            status: "pass",
            duration: 12,
            blocks: ["App component"],
          },
        ],
      },
    });

    assert.strictEqual(browserOutcome.status, "PASSED");
    assert.strictEqual(browserOutcome.results.length, 1);
    assert.strictEqual(browserOutcome.results[0]?.passed, true);
  });

  // 11. Challenge dispatcher check
  it("Job dispatcher correctly detects Node full-stack challenge vs browser", () => {
    const nodeRun = {
      id: "run-node",
      submissionId: "sub-node",
      assignmentId: "asg-node",
      submission: {
        id: "sub-node",
        data: { "backend/server.js": "code" },
        attachmentId: "att-node",
      },
      assignment: {
        id: "asg-node",
        submissionMode: "WORKSPACE",
        sandboxTemplate: null,
        hiddenTestFiles: null,
      },
    };

    const browserRun = {
      id: "run-browser",
      submissionId: "sub-browser",
      assignmentId: "asg-browser",
      submission: {
        id: "sub-browser",
        data: { "App.js": "code" },
        attachmentId: "att-browser",
      },
      assignment: {
        id: "asg-browser",
        submissionMode: "SANDBOX",
        sandboxTemplate: null,
        hiddenTestFiles: null,
      },
    };

    assert.strictEqual(isNodeChallenge(nodeRun), true, "WORKSPACE must route to Node runner");
    assert.strictEqual(isNodeChallenge(browserRun), false, "SANDBOX must route to browser runner");
  });
});
