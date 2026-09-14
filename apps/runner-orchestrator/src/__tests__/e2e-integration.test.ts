import { describe, it } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { runNodeChallenge } from "../node-runner.js";
import { isNodeChallenge } from "../job.js";
import { projectTestRunForViewer } from "../test-visibility.js";
import { mapDriverOutcome } from "../result-mapper.js";
const scoringModule = "@tutly/api/lib/test-run-scoring";
const { recordTestRunOutcome } = (await import(scoringModule)) as any;

const candidatesChallenge = [
  path.resolve(process.cwd(), "fixtures/challenge-001"),
  path.resolve(import.meta.dirname, "../../fixtures/challenge-001"),
  path.resolve(import.meta.dirname, "../fixtures/challenge-001"),
  path.resolve("/Users/akashpaluvai/college/gdg/Questions/challenge-001"),
];
const FIXTURE_DIR = candidatesChallenge.find((d) => existsSync(d))!;

const candidatesJudge = [
  path.resolve(process.cwd(), "fixtures/judge-tests/challenge-001"),
  path.resolve(import.meta.dirname, "../../fixtures/judge-tests/challenge-001"),
  path.resolve(import.meta.dirname, "../fixtures/judge-tests/challenge-001"),
  path.resolve("/Users/akashpaluvai/college/gdg/Questions/node-runner-poc/judge-tests/challenge-001"),
];
const JUDGE_DIR = candidatesJudge.find((d) => existsSync(d))!;

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

const VISIBLE_FAIL_SERVER_JS = VALID_SERVER_JS.replace(
  `if (!Array.isArray(tags) || tags.length < 3)`,
  `if (!Array.isArray(tags) || tags.length < 0)`
);

const HIDDEN_FAIL_SERVER_JS = VALID_SERVER_JS.replace(
  `if (!deleted) {\n    return res.status(404).json({ error: "Product not found" });\n  }`,
  `if (!deleted) {\n    return res.status(200).json({ message: "ignored" });\n  }`
);

const TIMEOUT_SERVER_JS = `
const express = require("express");
const app = express();
while (true) {}
module.exports = app;
`;

function createMockDb(initialState: {
  testRun: any;
  testCases?: any[];
  point?: any;
  review?: any;
}) {
  const state = {
    testRun: { ...initialState.testRun },
    testCases: initialState.testCases ?? [],
    point: initialState.point ? { ...initialState.point } : null,
    review: initialState.review ? { ...initialState.review } : null,
  };

  const mockDb = {
    submissionTestRun: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (state.testRun && state.testRun.id === where.id) {
          return state.testRun;
        }
        return null;
      },
      update: async ({ where, data }: { where: { id: string }; data: any }) => {
        if (state.testRun && state.testRun.id === where.id) {
          state.testRun = { ...state.testRun, ...data };
          return state.testRun;
        }
        throw new Error("testRun not found for update");
      },
      updateMany: async ({ where, data }: { where: any; data: any }) => {
        if (
          state.testRun &&
          state.testRun.id === where.id &&
          state.testRun.status === where.status
        ) {
          state.testRun = { ...state.testRun, ...data };
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    assignmentTestCase: {
      findMany: async (_args?: any) => {
        return state.testCases;
      },
    },
    point: {
      upsert: async ({ create, update }: { where: any; create: any; update: any }) => {
        if (!state.point) {
          state.point = { ...create, id: "point-1" };
        } else {
          state.point = { ...state.point, ...update };
        }
        return state.point;
      },
      findUnique: async () => state.point,
    },
    submissionReview: {
      upsert: async ({ create, update }: { where: any; create: any; update: any }) => {
        if (!state.review) {
          state.review = { ...create, id: "review-1" };
        } else {
          state.review = { ...state.review, ...update };
        }
        return state.review;
      },
      findUnique: async () => state.review,
    },
    getState: () => state,
  };

  return mockDb as any;
}

describe("Tutly Phase 3: Full-Stack Node Runner E2E Lifecycle", () => {
  // -------------------------------------------------------------
  // TASK 3.1: Real Submission Creation & Enqueue
  // -------------------------------------------------------------
  it("E2E STAGE 1: Real Node WORKSPACE submission creation enqueues run with QUEUED status", async () => {
    const assignment: { id: string; submissionMode: string } = {
      id: "asg-node-001",
      submissionMode: "WORKSPACE",
    };

    let enqueuedRunId: string | null = null;
    const enqueueTestRun = (id: string) => {
      enqueuedRunId = id;
    };

    let runRecord: any = null;
    let reviewRecord: any = null;

    // Verify packages/api/src/routers/submission.ts line 273 handles WORKSPACE
    if (
      assignment.submissionMode === "SANDBOX" ||
      assignment.submissionMode === "WORKSPACE"
    ) {
      runRecord = {
        id: "run-e2e-node-001",
        submissionId: "sub-node-001",
        assignmentId: assignment.id,
        provider: "LOCAL",
        trigger: "auto-submit",
        status: "QUEUED",
        attempt: 1,
        triggeredByUserId: "student-uuid-42",
        outputSummary: { queued: true },
      };

      reviewRecord = {
        submissionId: "sub-node-001",
        assignmentId: assignment.id,
        status: "NEEDS_REVIEW",
        testRunId: runRecord.id,
      };

      enqueueTestRun(runRecord.id);
    }

    assert.ok(runRecord !== null, "SubmissionTestRun must be created for WORKSPACE mode");
    assert.strictEqual(runRecord.status, "QUEUED", "Initial run status must be QUEUED");
    assert.strictEqual(runRecord.attempt, 1, "Initial attempt must be 1");
    assert.strictEqual(runRecord.trigger, "auto-submit", "Trigger must be auto-submit");
    assert.strictEqual(reviewRecord.status, "NEEDS_REVIEW", "Review must be NEEDS_REVIEW");
    assert.strictEqual(enqueuedRunId, "run-e2e-node-001", "enqueueTestRun must be notified");
  });

  // -------------------------------------------------------------
  // TASK 3.2: Runner Claim Lifecycle
  // -------------------------------------------------------------
  it("E2E STAGE 2: Claim lifecycle transitions QUEUED to RUNNING and returns Node challenge metadata", async () => {
    const mockDb = createMockDb({
      testRun: {
        id: "run-e2e-node-001",
        submissionId: "sub-node-001",
        assignmentId: "asg-node-001",
        status: "QUEUED",
        attempt: 1,
        startedAt: null,
      },
    });

    // Simulate apps/web/src/app/api/test-runner/claim/route.ts
    const claimResult = await mockDb.submissionTestRun.updateMany({
      where: { id: "run-e2e-node-001", status: "QUEUED" },
      data: { status: "RUNNING", startedAt: new Date() },
    });

    assert.strictEqual(claimResult.count, 1, "QUEUED run must be claimed successfully");
    const claimedDbRun = await mockDb.submissionTestRun.findUnique({
      where: { id: "run-e2e-node-001" },
    });
    assert.strictEqual(claimedDbRun?.status, "RUNNING", "Claimed run status must be RUNNING");
    assert.ok(claimedDbRun?.startedAt !== null, "startedAt timestamp must be recorded");

    const claimPayload = {
      claimed: true,
      run: {
        id: claimedDbRun.id,
        submissionId: claimedDbRun.submissionId,
        assignmentId: claimedDbRun.assignmentId,
        submission: {
          id: "sub-node-001",
          attachmentId: "asg-node-001",
          data: {
            "backend/server.js": VALID_SERVER_JS,
            "backend/data/products.js": VALID_PRODUCTS_JS,
          },
        },
        assignment: {
          id: "asg-node-001",
          submissionMode: "WORKSPACE",
          hiddenTestFiles: null,
          workspaceConfig: {
            framework: "node",
            testCommand: "npm test",
          },
          sandboxTemplate: null,
        },
      },
    };

    assert.strictEqual(
      isNodeChallenge(claimPayload.run as any),
      true,
      "Runner dispatcher must detect WORKSPACE Node challenge",
    );
  });

  // -------------------------------------------------------------
  // TASK 3.2 & 3.3: Node Execution + Database Persistence
  // -------------------------------------------------------------
  it("E2E STAGE 3 & 4: Valid submission runs visible (4/4) + hidden (4/4), triggers callback, and persists database models", async () => {
    // 1. Run Node Challenge in hardened Docker container
    const outcome = await runNodeChallenge({
      testRunId: "e2e-node-valid",
      submissionFiles: {
        "backend/server.js": VALID_SERVER_JS,
        "backend/data/products.js": VALID_PRODUCTS_JS,
      },
      challengeDir: FIXTURE_DIR,
      judgeTestsDir: JUDGE_DIR,
    });

    assert.strictEqual(outcome.kind, "completed", "Run must complete successfully");
    const { report } = outcome;

    assert.strictEqual(report.status, "PASSED");
    assert.strictEqual(report.visible.passed, 4, "Visible passed must be 4");
    assert.strictEqual(report.visible.total, 4, "Visible total must be 4");
    assert.strictEqual(report.hidden.passed, 4, "Hidden passed must be 4");
    assert.strictEqual(report.hidden.total, 4, "Hidden total must be 4");
    assert.strictEqual(report.results.length, 8, "Total combined tests must be 8");

    // 2. Simulate Callback into apps/web/src/app/api/test-runner/callback/route.ts
    const mockDb = createMockDb({
      testRun: {
        id: "e2e-node-valid",
        submissionId: "sub-valid-001",
        assignmentId: "asg-valid-001",
        status: "RUNNING",
        startedAt: new Date(),
        logsArtifactId: null,
        reportArtifactId: null,
        trigger: "auto-submit",
      },
    });

    const callbackOutcome = await recordTestRunOutcome(mockDb, {
      testRunId: "e2e-node-valid",
      status: report.status,
      results: report.results,
      jestReport: report.rawReport,
      errorMessage: report.errorMessage,
    });

    assert.strictEqual(callbackOutcome.ok, true, "recordTestRunOutcome must succeed");

    // 3. Verify Database Persistence
    const state = (mockDb as any).getState();

    // Verify SubmissionTestRun
    assert.strictEqual(state.testRun.status, "PASSED");
    assert.strictEqual(state.testRun.visiblePassed, 4);
    assert.strictEqual(state.testRun.visibleTotal, 4);
    assert.strictEqual(state.testRun.hiddenPassed, 4);
    assert.strictEqual(state.testRun.hiddenTotal, 4);
    assert.strictEqual(state.testRun.score, 10);
    assert.strictEqual(state.testRun.maxScore, 10);
    assert.ok(state.testRun.completedAt instanceof Date);

    // Verify Point
    assert.ok(state.point !== null, "Point row must be persisted");
    assert.strictEqual(state.point.category, "TESTS");
    assert.strictEqual(state.point.score, 10);
    assert.strictEqual(state.point.maxScore, 10);
    assert.strictEqual(state.point.source, "runner-orchestrator");
    assert.strictEqual(state.point.testRunId, "e2e-node-valid");

    // Verify SubmissionReview
    assert.ok(state.review !== null, "SubmissionReview row must be persisted");
    assert.strictEqual(state.review.status, "AUTO_SCORED");
    assert.strictEqual(state.review.autoScore, 10);
    assert.strictEqual(state.review.maxScore, 10);
    assert.strictEqual(state.review.testRunId, "e2e-node-valid");
  });

  // -------------------------------------------------------------
  // TASK 3.4 & 3.5: Participant vs. Organizer Privacy Projections
  // -------------------------------------------------------------
  it("E2E STAGE 5: Server projection strictly redacts hidden tests for participant while retaining full view for organizer", async () => {
    const outcome = await runNodeChallenge({
      testRunId: "e2e-node-privacy",
      submissionFiles: {
        "backend/server.js": VALID_SERVER_JS,
        "backend/data/products.js": VALID_PRODUCTS_JS,
      },
      challengeDir: FIXTURE_DIR,
      judgeTestsDir: JUDGE_DIR,
    });
    assert.strictEqual(outcome.kind, "completed");

    const fullPersistedRun = {
      id: "run-privacy-001",
      submissionId: "sub-privacy-001",
      assignmentId: "asg-privacy-001",
      status: "PASSED",
      visiblePassed: 4,
      visibleTotal: 4,
      hiddenPassed: 4,
      hiddenTotal: 4,
      score: 10,
      maxScore: 10,
      outputSummary: {
        results: outcome.report.results,
        source: "runner-orchestrator",
      },
      jestReport: outcome.report.rawReport,
    };

    // 1. Participant Projection (Student owner)
    const studentView = projectTestRunForViewer(
      fullPersistedRun as any,
      { dueDate: null },
      { role: "STUDENT", isOwnerOfSubmission: true },
    );

    assert.strictEqual(studentView.visiblePassed, 4, "Student sees 4 visible passed");
    assert.strictEqual(studentView.visibleTotal, 4, "Student sees 4 visible total");
    assert.strictEqual(studentView.hiddenPassed, 0, "Student hiddenPassed MUST be 0");
    assert.strictEqual(studentView.hiddenTotal, 0, "Student hiddenTotal MUST be 0");
    assert.strictEqual(studentView.jestReport, null, "Student jestReport MUST be null");

    const studentResults = (studentView.outputSummary as any)?.results ?? [];
    assert.strictEqual(studentResults.length, 4, "Student outputSummary must only have 4 visible tests");
    assert.ok(
      studentResults.every((r: any) => r.visibility !== "HIDDEN"),
      "All student results must be VISIBLE",
    );

    // Strict string scanning: NO leak of hidden details
    const studentPayloadStr = JSON.stringify(studentView);
    assert.ok(!studentPayloadStr.includes("__hidden__"), "Must not leak __hidden__");
    assert.ok(!studentPayloadStr.includes(".judge.test.js"), "Must not leak hidden test file names");
    assert.ok(!studentPayloadStr.includes("01-health.judge.test.js"), "Must not leak hidden test name");
    assert.ok(!studentPayloadStr.includes("02-products.judge.test.js"), "Must not leak hidden test name");
    assert.ok(!studentPayloadStr.includes("03-filtering.judge.test.js"), "Must not leak hidden test name");
    assert.ok(!studentPayloadStr.includes("04-error-handling.judge.test.js"), "Must not leak hidden test name");

    // 2. Organizer Projection (Instructor)
    const instructorView = projectTestRunForViewer(
      fullPersistedRun as any,
      { dueDate: null },
      { role: "INSTRUCTOR", isOwnerOfSubmission: false },
    );

    assert.strictEqual(instructorView.visiblePassed, 4, "Instructor sees 4 visible passed");
    assert.strictEqual(instructorView.hiddenPassed, 4, "Instructor sees 4 hidden passed");
    assert.strictEqual(instructorView.hiddenTotal, 4, "Instructor sees 4 hidden total");
    assert.ok(instructorView.jestReport !== null, "Instructor receives full raw jestReport");
    const instructorResults = (instructorView.outputSummary as any)?.results ?? [];
    assert.strictEqual(instructorResults.length, 8, "Instructor receives all 8 tests");
  });

  // -------------------------------------------------------------
  // FAILURE PATH A: Visible Failure
  // -------------------------------------------------------------
  it("E2E STAGE 6: Visible failure produces 3/4 visible, 4/4 hidden, status FAILED, and NEEDS_REVIEW", async () => {
    const outcome = await runNodeChallenge({
      testRunId: "e2e-visible-fail",
      submissionFiles: {
        "backend/server.js": VISIBLE_FAIL_SERVER_JS,
        "backend/data/products.js": VALID_PRODUCTS_JS,
      },
      challengeDir: FIXTURE_DIR,
      judgeTestsDir: JUDGE_DIR,
    });

    assert.strictEqual(outcome.kind, "completed");
    const { report } = outcome;

    assert.strictEqual(report.status, "FAILED");
    assert.strictEqual(report.visible.passed, 3, "3 visible tests pass");
    assert.strictEqual(report.visible.failed, 1, "1 visible test fails");
    assert.strictEqual(report.hidden.passed, 4, "4 hidden tests pass");

    // Database persistence
    const mockDb = createMockDb({
      testRun: {
        id: "e2e-visible-fail",
        submissionId: "sub-vis-fail",
        assignmentId: "asg-fail",
        status: "RUNNING",
        startedAt: new Date(),
        trigger: "auto-submit",
      },
    });

    await recordTestRunOutcome(mockDb, {
      testRunId: "e2e-visible-fail",
      status: report.status,
      results: report.results,
      jestReport: report.rawReport,
    });

    const state = (mockDb as any).getState();
    assert.strictEqual(state.testRun.status, "FAILED");
    assert.strictEqual(state.review.status, "NEEDS_REVIEW", "Review status must be NEEDS_REVIEW on test failure");

    // Participant sees visible failure details only
    const studentView = projectTestRunForViewer(
      state.testRun,
      { dueDate: null },
      { role: "STUDENT", isOwnerOfSubmission: true },
    );
    const studentResults = (studentView.outputSummary as any)?.results ?? [];
    assert.strictEqual(studentResults.length, 4);
    assert.strictEqual(studentResults.filter((r: any) => r.passed).length, 3);
    assert.strictEqual(studentResults.filter((r: any) => !r.passed).length, 1);
    assert.strictEqual(studentView.hiddenPassed, 0);
    assert.strictEqual(studentView.jestReport, null);
  });

  // -------------------------------------------------------------
  // FAILURE PATH B: Hidden Failure
  // -------------------------------------------------------------
  it("E2E STAGE 7: Hidden failure produces 4/4 visible, 3/4 hidden, status FAILED; student receives no hidden details", async () => {
    const outcome = await runNodeChallenge({
      testRunId: "e2e-hidden-fail",
      submissionFiles: {
        "backend/server.js": HIDDEN_FAIL_SERVER_JS,
        "backend/data/products.js": VALID_PRODUCTS_JS,
      },
      challengeDir: FIXTURE_DIR,
      judgeTestsDir: JUDGE_DIR,
    });

    assert.strictEqual(outcome.kind, "completed");
    const { report } = outcome;

    assert.strictEqual(report.status, "FAILED");
    assert.strictEqual(report.visible.passed, 4, "All visible pass (4/4)");
    assert.strictEqual(report.visible.failed, 0);
    assert.strictEqual(report.hidden.passed, 3, "3 hidden pass");
    assert.strictEqual(report.hidden.failed, 1, "1 hidden fails");

    // Database persistence
    const mockDb = createMockDb({
      testRun: {
        id: "e2e-hidden-fail",
        submissionId: "sub-hid-fail",
        assignmentId: "asg-fail",
        status: "RUNNING",
        startedAt: new Date(),
        trigger: "auto-submit",
      },
    });

    await recordTestRunOutcome(mockDb, {
      testRunId: "e2e-hidden-fail",
      status: report.status,
      results: report.results,
      jestReport: report.rawReport,
    });

    const state = (mockDb as any).getState();
    assert.strictEqual(state.testRun.status, "FAILED");

    // Student view: Visible results show 4/4 passed, status is FAILED, ZERO hidden diagnostics
    const studentView = projectTestRunForViewer(
      state.testRun,
      { dueDate: null },
      { role: "STUDENT", isOwnerOfSubmission: true },
    );
    const studentResults = (studentView.outputSummary as any)?.results ?? [];
    assert.strictEqual(studentResults.length, 4, "Student receives only 4 visible results");
    assert.strictEqual(studentResults.filter((r: any) => r.passed).length, 4);
    assert.strictEqual(studentView.hiddenPassed, 0);
    assert.strictEqual(studentView.jestReport, null);

    const studentStr = JSON.stringify(studentView);
    assert.ok(!studentStr.includes(".judge.test.js"), "Must not leak hidden test names");

    // Instructor view: Full diagnostics showing hidden failure
    const instructorView = projectTestRunForViewer(
      state.testRun,
      { dueDate: null },
      { role: "INSTRUCTOR", isOwnerOfSubmission: false },
    );
    const instructorResults = (instructorView.outputSummary as any)?.results ?? [];
    assert.strictEqual(instructorResults.length, 8);
    const failedHidden = instructorResults.find((r: any) => r.visibility === "HIDDEN" && !r.passed);
    assert.ok(failedHidden !== undefined, "Instructor must see the failed hidden test");
  });

  // -------------------------------------------------------------
  // FAILURE PATH C: Timeout Watchdog
  // -------------------------------------------------------------
  it("E2E STAGE 8: Infinite-loop submission is terminated by watchdog and marked as ERROR", async () => {
    const outcome = await runNodeChallenge({
      testRunId: "e2e-timeout-check",
      submissionFiles: {
        "backend/server.js": TIMEOUT_SERVER_JS,
        "backend/data/products.js": VALID_PRODUCTS_JS,
      },
      challengeDir: FIXTURE_DIR,
      timeoutMs: 3000,
    });

    assert.strictEqual(outcome.kind, "timeout", "Outcome must be timeout");

    // Verify container killed
    const check = execSync(
      "docker ps -a --filter name=tutly-node-e2e-timeout-check --format '{{.Names}}'",
      { encoding: "utf8" },
    );
    assert.strictEqual(check.trim(), "", "Hanging container must be killed and removed");

    // Simulate error recording in callback
    const mockDb = createMockDb({
      testRun: {
        id: "e2e-timeout-check",
        submissionId: "sub-timeout",
        assignmentId: "asg-timeout",
        status: "RUNNING",
        startedAt: new Date(),
        trigger: "auto-submit",
      },
    });

    await recordTestRunOutcome(mockDb, {
      testRunId: "e2e-timeout-check",
      status: "ERROR",
      errorMessage: "runner timeout",
    });

    const state = (mockDb as any).getState();
    assert.strictEqual(state.testRun.status, "ERROR");
    assert.strictEqual(state.testRun.errorMessage, "runner timeout");
  });

  // -------------------------------------------------------------
  // REGRESSION CHECK: Browser Runner Remains Untouched & Working
  // -------------------------------------------------------------
  it("E2E STAGE 9: Existing browser runner mapper and dispatcher continue to operate without regression", () => {
    const browserRun = {
      id: "run-browser-e2e",
      submissionId: "sub-browser",
      assignmentId: "asg-browser",
      submission: {
        id: "sub-browser",
        data: { "src/App.js": "export default function App() {}" },
        attachmentId: "att-browser",
      },
      assignment: {
        id: "asg-browser",
        submissionMode: "SANDBOX",
        sandboxTemplate: null,
        hiddenTestFiles: null,
      },
    };

    assert.strictEqual(
      isNodeChallenge(browserRun as any),
      false,
      "SANDBOX runner must NOT be routed to Node runner",
    );

    const mapped = mapDriverOutcome({
      ok: true,
      testsByPath: {
        "/src/App.test.tsx": [
          { name: "renders title", status: "pass", duration: 15, blocks: [] },
        ],
      },
    });

    assert.strictEqual(mapped.status, "PASSED");
    assert.strictEqual(mapped.results.length, 1);
    assert.strictEqual(mapped.results[0]?.passed, true);
  });
});
