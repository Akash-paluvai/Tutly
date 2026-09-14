import { describe, it } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { runNodeChallenge } from "../node-runner.js";
import { projectTestRunForViewer } from "../test-visibility.js";

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

function createCustomProductsJs(customPrefix: string) {
  return VALID_PRODUCTS_JS.replace(
    `name: "Laptop"`,
    `name: "${customPrefix}-Laptop"`
  );
}

function createConcurrentMockDb() {
  const testRuns = new Map<string, any>();
  const points = new Map<string, any>();
  const reviews = new Map<string, any>();

  const mockDb = {
    submissionTestRun: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        return testRuns.get(where.id) ?? null;
      },
      update: async ({ where, data }: { where: { id: string }; data: any }) => {
        const existing = testRuns.get(where.id);
        if (!existing) throw new Error(`testRun ${where.id} not found`);
        const updated = { ...existing, ...data };
        testRuns.set(where.id, updated);
        return updated;
      },
      updateMany: async ({ where, data }: { where: any; data: any }) => {
        const existing = testRuns.get(where.id);
        if (existing && existing.status === where.status) {
          testRuns.set(where.id, { ...existing, ...data });
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    assignmentTestCase: {
      findMany: async () => [],
    },
    point: {
      upsert: async ({ where, create, update }: { where: any; create: any; update: any }) => {
        const key = `${where.submissionId_category.submissionId}_${where.submissionId_category.category}`;
        const existing = points.get(key);
        if (!existing) {
          const inserted = { ...create, id: `point-${key}` };
          points.set(key, inserted);
          return inserted;
        }
        const updated = { ...existing, ...update };
        points.set(key, updated);
        return updated;
      },
    },
    submissionReview: {
      upsert: async ({ where, create, update }: { where: any; create: any; update: any }) => {
        const key = where.submissionId;
        const existing = reviews.get(key);
        if (!existing) {
          const inserted = { ...create, id: `review-${key}` };
          reviews.set(key, inserted);
          return inserted;
        }
        const updated = { ...existing, ...update };
        reviews.set(key, updated);
        return updated;
      },
    },
    seedRun: (run: any) => {
      testRuns.set(run.id, { ...run });
    },
    getSnapshot: () => ({
      testRuns: Array.from(testRuns.values()),
      points: Array.from(points.values()),
      reviews: Array.from(reviews.values()),
    }),
  };

  return mockDb as any;
}

describe("Tutly Phase 4: Concurrency, Failure-Path Stress, and Production Scale", () => {
  // -------------------------------------------------------------
  // TEST A: 2 Concurrent Submissions
  // -------------------------------------------------------------
  it("TEST A: 2 concurrent submissions execute independently and persist correct scores", { timeout: 30000 }, async () => {
    const mockDb = createConcurrentMockDb();

    mockDb.seedRun({
      id: "run-c2-1",
      submissionId: "sub-c2-1",
      assignmentId: "asg-001",
      status: "RUNNING",
      startedAt: new Date(),
      trigger: "auto-submit",
    });
    mockDb.seedRun({
      id: "run-c2-2",
      submissionId: "sub-c2-2",
      assignmentId: "asg-001",
      status: "RUNNING",
      startedAt: new Date(),
      trigger: "auto-submit",
    });

    const [outcome1, outcome2] = await Promise.all([
      runNodeChallenge({
        testRunId: "run-c2-1",
        submissionFiles: {
          "backend/server.js": VALID_SERVER_JS,
          "backend/data/products.js": VALID_PRODUCTS_JS,
        },
        challengeDir: FIXTURE_DIR,
        judgeTestsDir: JUDGE_DIR,
      }),
      runNodeChallenge({
        testRunId: "run-c2-2",
        submissionFiles: {
          "backend/server.js": VALID_SERVER_JS,
          "backend/data/products.js": VALID_PRODUCTS_JS,
        },
        challengeDir: FIXTURE_DIR,
        judgeTestsDir: JUDGE_DIR,
      }),
    ]);

    assert.strictEqual(outcome1.kind, "completed");
    assert.strictEqual(outcome2.kind, "completed");
    assert.strictEqual(outcome1.report.status, "PASSED");
    assert.strictEqual(outcome2.report.status, "PASSED");
    assert.strictEqual(outcome1.report.visible.passed, 4);
    assert.strictEqual(outcome2.report.visible.passed, 4);
    assert.strictEqual(outcome1.report.hidden.passed, 4);
    assert.strictEqual(outcome2.report.hidden.passed, 4);

    // Persist via callbacks concurrently
    await Promise.all([
      recordTestRunOutcome(mockDb, {
        testRunId: "run-c2-1",
        status: outcome1.report.status,
        results: outcome1.report.results,
        jestReport: outcome1.report.rawReport,
      }),
      recordTestRunOutcome(mockDb, {
        testRunId: "run-c2-2",
        status: outcome2.report.status,
        results: outcome2.report.results,
        jestReport: outcome2.report.rawReport,
      }),
    ]);

    const { testRuns, points, reviews } = mockDb.getSnapshot();
    assert.strictEqual(testRuns.length, 2);
    assert.strictEqual(points.length, 2);
    assert.strictEqual(reviews.length, 2);

    for (const run of testRuns) {
      assert.strictEqual(run.status, "PASSED");
      assert.strictEqual(run.score, 10);
      assert.strictEqual(run.maxScore, 10);
    }
    for (const pt of points) {
      assert.strictEqual(pt.score, 10);
      assert.strictEqual(pt.category, "TESTS");
    }
    for (const rev of reviews) {
      assert.strictEqual(rev.status, "AUTO_SCORED");
      assert.strictEqual(rev.autoScore, 10);
    }
  });

  // -------------------------------------------------------------
  // TEST B: 5 Concurrent Submissions
  // -------------------------------------------------------------
  it("TEST B: 5 concurrent submissions execute cleanly with high throughput", { timeout: 45000 }, async () => {
    const mockDb = createConcurrentMockDb();
    const count = 5;
    const runIds = Array.from({ length: count }, (_, i) => `run-c5-${i + 1}`);

    for (let i = 0; i < count; i++) {
      mockDb.seedRun({
        id: runIds[i],
        submissionId: `sub-c5-${i + 1}`,
        assignmentId: "asg-001",
        status: "RUNNING",
        startedAt: new Date(),
        trigger: "auto-submit",
      });
    }

    const tStart = Date.now();
    const outcomes = await Promise.all(
      runIds.map((id) =>
        runNodeChallenge({
          testRunId: id,
          submissionFiles: {
            "backend/server.js": VALID_SERVER_JS,
            "backend/data/products.js": VALID_PRODUCTS_JS,
          },
          challengeDir: FIXTURE_DIR,
          judgeTestsDir: JUDGE_DIR,
        }),
      ),
    );
    const durationMs = Date.now() - tStart;

    assert.strictEqual(outcomes.length, 5);
    for (const out of outcomes) {
      assert.strictEqual(out.kind, "completed");
      assert.strictEqual(out.report.status, "PASSED");
      assert.strictEqual(out.report.visible.passed, 4);
      assert.strictEqual(out.report.hidden.passed, 4);
    }

    // Persist all 5 callbacks concurrently
    await Promise.all(
      outcomes.map((out: any, i) =>
        recordTestRunOutcome(mockDb, {
          testRunId: runIds[i],
          status: out.report.status,
          results: out.report.results,
          jestReport: out.report.rawReport,
        }),
      ),
    );

    const { testRuns, points, reviews } = mockDb.getSnapshot();
    assert.strictEqual(testRuns.length, 5);
    assert.strictEqual(points.length, 5);
    assert.strictEqual(reviews.length, 5);
    assert.ok(durationMs < 35000, `5 concurrent runs should complete promptly (took ${durationMs}ms)`);
  });

  // -------------------------------------------------------------
  // TEST C: 10 Concurrent Submissions (Scale Verification)
  // -------------------------------------------------------------
  it("TEST C: 10 Concurrent Submissions (Scale Verification)", { timeout: 60000 }, async () => {
    const runIds = Array.from({ length: 10 }, (_, i) => `run-c10-${i + 1}`);

    const tStart = Date.now();
    const outcomes = await Promise.all(
      runIds.map((id) =>
        runNodeChallenge({
          testRunId: id,
          submissionFiles: {
            "backend/server.js": VALID_SERVER_JS,
            "backend/data/products.js": VALID_PRODUCTS_JS,
          },
          challengeDir: FIXTURE_DIR,
          judgeTestsDir: JUDGE_DIR,
        }),
      ),
    );
    const durationMs = Date.now() - tStart;

    assert.strictEqual(outcomes.length, 10);
    const passedCount = outcomes.filter(
      (o: any) => o.kind === "completed" && o.report.status === "PASSED",
    ).length;
    assert.strictEqual(passedCount, 10, "All 10 concurrent submissions must pass");
    assert.ok(durationMs < 60000, `10 concurrent runs should complete under timeout (took ${durationMs}ms)`);

    // Check no dangling containers from these runs
    const orphanedCheck = execSync(
      "docker ps -a --filter name=tutly-node-run-c10- --format '{{.Names}}'",
      { encoding: "utf8" },
    );
    assert.strictEqual(
      orphanedCheck.trim(),
      "",
      "No orphaned containers should remain after 10 concurrent runs",
    );
  });

  // -------------------------------------------------------------
  // TEST D: Strict Workspace Isolation
  // -------------------------------------------------------------
  it("TEST D: Submissions with distinct payloads execute in completely isolated physical workspaces", { timeout: 30000 }, async () => {
    const [alpha, beta, gamma] = (await Promise.all([
      runNodeChallenge({
        testRunId: "run-iso-alpha",
        submissionFiles: {
          "backend/server.js": VALID_SERVER_JS,
          "backend/data/products.js": createCustomProductsJs("Alpha"),
        },
        challengeDir: FIXTURE_DIR,
        judgeTestsDir: JUDGE_DIR,
      }),
      runNodeChallenge({
        testRunId: "run-iso-beta",
        submissionFiles: {
          "backend/server.js": VALID_SERVER_JS,
          "backend/data/products.js": createCustomProductsJs("Beta"),
        },
        challengeDir: FIXTURE_DIR,
        judgeTestsDir: JUDGE_DIR,
      }),
      runNodeChallenge({
        testRunId: "run-iso-gamma",
        submissionFiles: {
          "backend/server.js": VALID_SERVER_JS,
          "backend/data/products.js": createCustomProductsJs("Gamma"),
        },
        challengeDir: FIXTURE_DIR,
        judgeTestsDir: JUDGE_DIR,
      }),
    ])) as any[];

    assert.strictEqual(alpha.kind, "completed");
    assert.strictEqual(beta.kind, "completed");
    assert.strictEqual(gamma.kind, "completed");

    // Verify all passed their own tests cleanly
    assert.strictEqual(alpha.report.status, "PASSED");
    assert.strictEqual(beta.report.status, "PASSED");
    assert.strictEqual(gamma.report.status, "PASSED");
  });

  // -------------------------------------------------------------
  // TEST E: Hidden-Test Privacy Isolation Under Concurrency
  // -------------------------------------------------------------
  it("TEST E: Concurrently executed valid and hidden-failing runs strictly protect hidden privacy", { timeout: 30000 }, async () => {
    const [runValidA, runHiddenFail, runValidB] = (await Promise.all([
      runNodeChallenge({
        testRunId: "run-priv-a",
        submissionFiles: {
          "backend/server.js": VALID_SERVER_JS,
          "backend/data/products.js": VALID_PRODUCTS_JS,
        },
        challengeDir: FIXTURE_DIR,
        judgeTestsDir: JUDGE_DIR,
      }),
      runNodeChallenge({
        testRunId: "run-priv-fail",
        submissionFiles: {
          "backend/server.js": HIDDEN_FAIL_SERVER_JS,
          "backend/data/products.js": VALID_PRODUCTS_JS,
        },
        challengeDir: FIXTURE_DIR,
        judgeTestsDir: JUDGE_DIR,
      }),
      runNodeChallenge({
        testRunId: "run-priv-b",
        submissionFiles: {
          "backend/server.js": VALID_SERVER_JS,
          "backend/data/products.js": VALID_PRODUCTS_JS,
        },
        challengeDir: FIXTURE_DIR,
        judgeTestsDir: JUDGE_DIR,
      }),
    ])) as any[];

    assert.strictEqual(runValidA.report.status, "PASSED");
    assert.strictEqual(runHiddenFail.report.status, "FAILED");
    assert.strictEqual(runValidB.report.status, "PASSED");

    // Project for participants
    const studentViewA = projectTestRunForViewer(
      {
        id: "run-priv-a",
        submissionId: "sub-a",
        assignmentId: "asg-1",
        status: runValidA.report.status,
        visiblePassed: runValidA.report.visible.passed,
        visibleTotal: runValidA.report.visible.total,
        hiddenPassed: runValidA.report.hidden.passed,
        hiddenTotal: runValidA.report.hidden.total,
        score: 10,
        maxScore: 10,
        outputSummary: { results: runValidA.report.results },
        jestReport: runValidA.report.rawReport,
      } as any,
      { dueDate: null },
      { role: "STUDENT", isOwnerOfSubmission: true },
    );

    const studentViewFail = projectTestRunForViewer(
      {
        id: "run-priv-fail",
        submissionId: "sub-fail",
        assignmentId: "asg-1",
        status: runHiddenFail.report.status,
        visiblePassed: runHiddenFail.report.visible.passed,
        visibleTotal: runHiddenFail.report.visible.total,
        hiddenPassed: runHiddenFail.report.hidden.passed,
        hiddenTotal: runHiddenFail.report.hidden.total,
        score: 5,
        maxScore: 10,
        outputSummary: { results: runHiddenFail.report.results },
        jestReport: runHiddenFail.report.rawReport,
      } as any,
      { dueDate: null },
      { role: "STUDENT", isOwnerOfSubmission: true },
    );

    const studentViewB = projectTestRunForViewer(
      {
        id: "run-priv-b",
        submissionId: "sub-b",
        assignmentId: "asg-1",
        status: runValidB.report.status,
        visiblePassed: runValidB.report.visible.passed,
        visibleTotal: runValidB.report.visible.total,
        hiddenPassed: runValidB.report.hidden.passed,
        hiddenTotal: runValidB.report.hidden.total,
        score: 10,
        maxScore: 10,
        outputSummary: { results: runValidB.report.results },
        jestReport: runValidB.report.rawReport,
      } as any,
      { dueDate: null },
      { role: "STUDENT", isOwnerOfSubmission: true },
    );

    // Verify all 3 student responses are strictly redacted
    for (const view of [studentViewA, studentViewFail, studentViewB]) {
      assert.strictEqual(view.hiddenPassed, 0);
      assert.strictEqual(view.hiddenTotal, 0);
      assert.strictEqual(view.jestReport, null);
      const str = JSON.stringify(view);
      assert.ok(!str.includes("__hidden__"), "Must not leak __hidden__");
      assert.ok(!str.includes(".judge.test.js"), "Must not leak judge test filename");
      assert.ok(!str.includes("01-health.judge.test.js"), "Must not leak health judge test");
    }

    // Instructor sees hidden failure diagnostics for failing run
    const instructorViewFail = projectTestRunForViewer(
      {
        id: "run-priv-fail",
        submissionId: "sub-fail",
        assignmentId: "asg-1",
        status: runHiddenFail.report.status,
        visiblePassed: runHiddenFail.report.visible.passed,
        visibleTotal: runHiddenFail.report.visible.total,
        hiddenPassed: runHiddenFail.report.hidden.passed,
        hiddenTotal: runHiddenFail.report.hidden.total,
        score: 5,
        maxScore: 10,
        outputSummary: { results: runHiddenFail.report.results },
        jestReport: runHiddenFail.report.rawReport,
      } as any,
      { dueDate: null },
      { role: "INSTRUCTOR", isOwnerOfSubmission: false },
    );

    assert.strictEqual(instructorViewFail.hiddenPassed, 3);
    assert.strictEqual(instructorViewFail.hiddenTotal, 4);
    assert.ok(instructorViewFail.jestReport !== null);
  });

  // -------------------------------------------------------------
  // TEST F: Queue & Claim Concurrency / Idempotency
  // -------------------------------------------------------------
  it("TEST F: Atomic claim update prevents duplicate claims and callbacks are idempotent", async () => {
    const mockDb = createConcurrentMockDb();
    const testRunId = "run-claim-race";

    mockDb.seedRun({
      id: testRunId,
      submissionId: "sub-claim-race",
      assignmentId: "asg-claim",
      status: "QUEUED",
      attempt: 1,
      startedAt: null,
    });

    // 5 workers attempt to claim the exact same run simultaneously
    const claimAttempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        mockDb.submissionTestRun.updateMany({
          where: { id: testRunId, status: "QUEUED" },
          data: { status: "RUNNING", startedAt: new Date() },
        }),
      ),
    );

    const successfulClaims = claimAttempts.filter((c) => c.count === 1).length;
    const failedClaims = claimAttempts.filter((c) => c.count === 0).length;

    assert.strictEqual(successfulClaims, 1, "Exactly one worker must claim the run");
    assert.strictEqual(failedClaims, 4, "Remaining 4 workers must get count: 0 (claimed: false)");

    // Verify callback idempotency: calling callback twice returns idempotent: true on second call
    const callback1 = await recordTestRunOutcome(mockDb, {
      testRunId,
      status: "PASSED",
      results: [],
    });
    assert.strictEqual(callback1.ok, true);
    assert.strictEqual(callback1.idempotent, false);

    const callback2 = await recordTestRunOutcome(mockDb, {
      testRunId,
      status: "PASSED",
      results: [],
    });
    assert.strictEqual(callback2.ok, true);
    assert.strictEqual(callback2.idempotent, true, "Subsequent callback must be idempotent");

    const { points } = mockDb.getSnapshot();
    assert.strictEqual(points.length, 1, "No duplicate point records may be created");
  });

  // -------------------------------------------------------------
  // TEST G: Mixed Failure Stress
  // -------------------------------------------------------------
  it("TEST G: Concurrently executing PASS, visible fail, hidden fail, timeout, and PASS jobs", { timeout: 45000 }, async () => {
    const mockDb = createConcurrentMockDb();
    const jobs = [
      { id: "run-m-1", kind: "pass", files: { "backend/server.js": VALID_SERVER_JS, "backend/data/products.js": VALID_PRODUCTS_JS } },
      { id: "run-m-2", kind: "vis-fail", files: { "backend/server.js": VISIBLE_FAIL_SERVER_JS, "backend/data/products.js": VALID_PRODUCTS_JS } },
      { id: "run-m-3", kind: "hid-fail", files: { "backend/server.js": HIDDEN_FAIL_SERVER_JS, "backend/data/products.js": VALID_PRODUCTS_JS } },
      { id: "run-m-4", kind: "timeout", timeoutMs: 3000, files: { "backend/server.js": TIMEOUT_SERVER_JS, "backend/data/products.js": VALID_PRODUCTS_JS } },
      { id: "run-m-5", kind: "pass", files: { "backend/server.js": VALID_SERVER_JS, "backend/data/products.js": VALID_PRODUCTS_JS } },
    ];

    for (const job of jobs) {
      mockDb.seedRun({
        id: job.id,
        submissionId: `sub-${job.id}`,
        assignmentId: "asg-mixed",
        status: "RUNNING",
        startedAt: new Date(),
        trigger: "auto-submit",
      });
    }

    const outcomes = await Promise.all(
      jobs.map((job) =>
        runNodeChallenge({
          testRunId: job.id,
          submissionFiles: job.files,
          challengeDir: FIXTURE_DIR,
          judgeTestsDir: JUDGE_DIR,
          timeoutMs: job.timeoutMs,
        }),
      ),
    );

    // Assert outcomes
    assert.strictEqual(outcomes[0].kind, "completed");
    assert.strictEqual(outcomes[0].report.status, "PASSED");

    assert.strictEqual(outcomes[1].kind, "completed");
    assert.strictEqual(outcomes[1].report.status, "FAILED");
    assert.strictEqual(outcomes[1].report.visible.failed, 1);

    assert.strictEqual(outcomes[2].kind, "completed");
    assert.strictEqual(outcomes[2].report.status, "FAILED");
    assert.strictEqual(outcomes[2].report.visible.passed, 4);
    assert.strictEqual(outcomes[2].report.hidden.failed, 1);

    assert.strictEqual(outcomes[3].kind, "timeout");

    assert.strictEqual(outcomes[4].kind, "completed");
    assert.strictEqual(outcomes[4].report.status, "PASSED");

    // Persist all 5 results
    await Promise.all([
      recordTestRunOutcome(mockDb, { testRunId: "run-m-1", status: "PASSED", results: outcomes[0].report.results }),
      recordTestRunOutcome(mockDb, { testRunId: "run-m-2", status: "FAILED", results: outcomes[1].report.results }),
      recordTestRunOutcome(mockDb, { testRunId: "run-m-3", status: "FAILED", results: outcomes[2].report.results }),
      recordTestRunOutcome(mockDb, { testRunId: "run-m-4", status: "ERROR", errorMessage: "runner timeout" }),
      recordTestRunOutcome(mockDb, { testRunId: "run-m-5", status: "PASSED", results: outcomes[4].report.results }),
    ]);

    const { testRuns, reviews } = mockDb.getSnapshot();
    assert.strictEqual(testRuns.length, 5);
    const reviewBySub = new Map(reviews.map((r: any) => [r.submissionId, r.status]));

    assert.strictEqual(reviewBySub.get("sub-run-m-1"), "AUTO_SCORED");
    assert.strictEqual(reviewBySub.get("sub-run-m-2"), "NEEDS_REVIEW");
    assert.strictEqual(reviewBySub.get("sub-run-m-3"), "NEEDS_REVIEW");
    assert.strictEqual(reviewBySub.get("sub-run-m-5"), "AUTO_SCORED");
  });

  // -------------------------------------------------------------
  // TEST H: Watchdog Timeout Isolation
  // -------------------------------------------------------------
  it("TEST H: Hanging submission watchdog terminates only the offending run while concurrent valid runs complete successfully", { timeout: 35000 }, async () => {
    const [outA, outB, outC] = await Promise.all([
      runNodeChallenge({
        testRunId: "run-to-a",
        submissionFiles: {
          "backend/server.js": TIMEOUT_SERVER_JS,
          "backend/data/products.js": VALID_PRODUCTS_JS,
        },
        challengeDir: FIXTURE_DIR,
        timeoutMs: 3000,
      }),
      runNodeChallenge({
        testRunId: "run-to-b",
        submissionFiles: {
          "backend/server.js": VALID_SERVER_JS,
          "backend/data/products.js": VALID_PRODUCTS_JS,
        },
        challengeDir: FIXTURE_DIR,
        judgeTestsDir: JUDGE_DIR,
      }),
      runNodeChallenge({
        testRunId: "run-to-c",
        submissionFiles: {
          "backend/server.js": VALID_SERVER_JS,
          "backend/data/products.js": VALID_PRODUCTS_JS,
        },
        challengeDir: FIXTURE_DIR,
        judgeTestsDir: JUDGE_DIR,
      }),
    ]);

    // Run A must be timed out and killed
    assert.strictEqual(outA.kind, "timeout", "Offending run must be killed on timeout");

    // Run B and Run C must NOT be affected and must PASS
    assert.strictEqual(outB.kind, "completed");
    assert.strictEqual(outB.report.status, "PASSED");
    assert.strictEqual(outB.report.visible.passed, 4);
    assert.strictEqual(outB.report.hidden.passed, 4);

    assert.strictEqual(outC.kind, "completed");
    assert.strictEqual(outC.report.status, "PASSED");
    assert.strictEqual(outC.report.visible.passed, 4);
    assert.strictEqual(outC.report.hidden.passed, 4);

    // Verify container for Run A is gone
    const checkA = execSync(
      "docker ps -a --filter name=tutly-node-run-to-a --format '{{.Names}}'",
      { encoding: "utf8" },
    );
    assert.strictEqual(checkA.trim(), "", "Run A container must be killed and removed");
  });

  // -------------------------------------------------------------
  // TEST I: Database Consistency & Integrity
  // -------------------------------------------------------------
  it("TEST I: Relationships between Submission, TestRun, Point, and Review remain strictly consistent", async () => {
    const mockDb = createConcurrentMockDb();

    // Seed 3 runs for 3 distinct submissions
    for (let i = 1; i <= 3; i++) {
      mockDb.seedRun({
        id: `run-rel-${i}`,
        submissionId: `sub-rel-${i}`,
        assignmentId: "asg-rel",
        status: "RUNNING",
        startedAt: new Date(),
        trigger: "auto-submit",
      });
    }

    // Persist callbacks
    await Promise.all([
      recordTestRunOutcome(mockDb, { testRunId: "run-rel-1", status: "PASSED", results: [] }),
      recordTestRunOutcome(mockDb, { testRunId: "run-rel-2", status: "FAILED", results: [] }),
      recordTestRunOutcome(mockDb, { testRunId: "run-rel-3", status: "PASSED", results: [] }),
    ]);

    const { testRuns, points, reviews } = mockDb.getSnapshot();

    assert.strictEqual(testRuns.length, 3);
    assert.strictEqual(points.length, 3);
    assert.strictEqual(reviews.length, 3);

    // Verify 1:1 mapping: each submission has exactly one review and one TESTS point
    const subIds = ["sub-rel-1", "sub-rel-2", "sub-rel-3"];
    for (const subId of subIds) {
      const subPoints = points.filter((p: any) => p.submissionId === subId && p.category === "TESTS");
      assert.strictEqual(subPoints.length, 1, `Submission ${subId} must have exactly one TESTS point`);

      const subReviews = reviews.filter((r: any) => r.submissionId === subId);
      assert.strictEqual(subReviews.length, 1, `Submission ${subId} must have exactly one review`);
    }
  });
});
