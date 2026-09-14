# Tutly Test Runner & Execution Pipeline: Core API Implementations

> **Audit Document:** `inspection3.md`  
> **Target System:** Tutly Core Monorepo (`apps/web`, `apps/runner-orchestrator`, `packages/api`, `packages/db`, `packages/storage`)  
> **Audited Components:**  
> 1. `/api/test-runner/claim` — Claiming queued runs and assembling execution templates  
> 2. `/api/test-runner/callback` — Ingesting runner outcomes, scoring, points & review persistence  
> 3. `SubmissionTestRun` Lifecycle — Code paths creating and enqueuing test runs across the platform  

---

## Table of Contents

1. [High-Level Architecture & Lifecycle Trace](#1-high-level-architecture--lifecycle-trace)
2. [Component 1: `/api/test-runner/claim`](#2-component-1-apitest-runnerclaim)
   - [Route Handler Source Code](#route-handler-source-code-claim)
   - [Associated Dependencies & Helpers](#associated-dependencies--helpers-claim)
   - [Runner Orchestrator Consumer (`claimRun`)](#runner-orchestrator-consumer-claimrun)
   - [Deep Dive: Security, Concurrency, and Policy Merging](#deep-dive-security-concurrency-and-policy-merging)
3. [Component 2: `/api/test-runner/callback`](#3-component-2-apitest-runnercallback)
   - [Route Handler Source Code](#route-handler-source-code-callback)
   - [Core Scoring & Persistence Logic (`recordTestRunOutcome`)](#core-scoring--persistence-logic-recordtestrunoutcome)
   - [Runner Orchestrator Consumer (`postResults`)](#runner-orchestrator-consumer-postresults)
   - [Deep Dive: Idempotency, Scoring Engine, and Review Automation](#deep-dive-idempotency-scoring-engine-and-review-automation)
4. [Component 3: Code That Creates & Enqueues `SubmissionTestRun`](#4-component-3-code-that-creates--enqueues-submissiontestrun)
   - [Prisma Schema Definition (`SubmissionTestRun`)](#prisma-schema-definition-submissiontestrun)
   - [HTTP Dispatcher Client (`runner-client.ts`)](#http-dispatcher-client-runner-clientts)
   - [Creation Point A: Student Submission (`auto-submit`)](#creation-point-a-student-submission-auto-submit)
   - [Creation Point B: Instructor Single Rerun (`instructor-rerun`)](#creation-point-b-instructor-single-rerun-instructor-rerun)
   - [Creation Point C: Bulk Assignment Rerun (`rerun-all`)](#creation-point-c-bulk-assignment-rerun-rerun-all)
   - [Creation Point D: Workspace Artifact with Hidden Tests (`official`)](#creation-point-d-workspace-artifact-with-hidden-tests-official)
   - [Creation Point E: Client-Side Visible Run Recording (`runVisible`)](#creation-point-e-client-side-visible-run-recording-runvisible)
5. [Summary Comparison & Architectural Observations](#5-summary-comparison--architectural-observations)

---

## 1. High-Level Architecture & Lifecycle Trace

The execution pipeline decouples submission reception, test orchestration, container execution, and scoring persistence via a state machine backed by Postgres, MinIO/S3, and authenticated HTTP endpoints:

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                          TUTLY TEST RUNNER ARCHITECTURE                                           │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

   [ Student or Instructor ]
               │
               ▼
   [ 1. CREATION & ENQUEUE ]
     • packages/api/src/routers/submission.ts (createSubmission, submitWorkspaceArtifact)
     • packages/api/src/routers/testRuns.ts (enqueueOfficial, rerunAllForAssignment)
     ──> Inserts `SubmissionTestRun` row in DB with status: 'QUEUED'
     ──> Dispatches HTTP POST to runner-orchestrator (/enqueue or /enqueue-batch) via runner-client.ts
               │
               ▼
   [ 2. ORCHESTRATOR QUEUE ]
     • apps/runner-orchestrator/src/index.ts & queue.ts
     ──> In-memory job queue receives testRunId
               │
               ▼
   [ 3. ATOMIC CLAIM: POST /api/test-runner/claim ]
     • apps/runner-orchestrator/src/callback.ts (`claimRun`)
     • apps/web/src/app/api/test-runner/claim/route.ts
     ──> Authenticates via header `X-Service-Token`
     ──> Atomic DB transition: status `QUEUED` -> `RUNNING`
     ──> Loads student files & base template from S3/MinIO
     ──> Merges template + student submission via `mergeForAudience(..., "runner")`
     ──> Returns full assembled workspace payload to runner orchestrator
               │
               ▼
   [ 4. ISOLATED RUNNER EXECUTION ]
     • apps/runner-orchestrator/src/job.ts & sandbox.ts & jest-runner.ts
     ──> Writes student files, visible tests, and server-side hidden tests to disk
     ──> Spawns Docker container (or local Playwright worker)
     ──> Runs tests in headless browser Sandpack runtime
     ──> Collects raw Jest report and maps results via result-mapper.ts
               │
               ▼
   [ 5. RESULT CALLBACK: POST /api/test-runner/callback ]
     • apps/runner-orchestrator/src/callback.ts (`postResults`)
     • apps/web/src/app/api/test-runner/callback/route.ts
     ──> Authenticates via header `X-Service-Token`
     ──> Calls `recordTestRunOutcome` (packages/api/src/lib/test-run-scoring.ts)
     ──> Computes weighted scores against `AssignmentTestCase` rows
     ──> Updates `SubmissionTestRun` (`PASSED`, `FAILED`, or `ERROR`)
     ──> Upserts `Point` (category: 'TESTS')
     ──> Updates `SubmissionReview` (`AUTO_SCORED` or `NEEDS_REVIEW`)
```

---

## 2. Component 1: `/api/test-runner/claim`

### Route Handler Source Code (claim)

**File Path:** `apps/web/src/app/api/test-runner/claim/route.ts`

```typescript
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { db } from "@tutly/db";
import { readSandpackTemplate, readSubmission } from "@tutly/storage";

import { locatorFrom, locatorSelect } from "@tutly/api/lib/storage-locator";
import {
  mergeForAudience,
  type SandpackTemplate,
} from "@tutly/api/lib/template-policy";

function checkSecret(req: NextRequest): boolean {
  const provided = req.headers.get("x-service-token") ?? "";
  const expected = process.env.TEST_RUNNER_SECRET ?? "";
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!checkSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { testRunId?: unknown };
  try {
    body = (await req.json()) as { testRunId?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body.testRunId !== "string") {
    return NextResponse.json({ error: "testRunId required" }, { status: 400 });
  }

  const claim = await db.submissionTestRun.updateMany({
    where: { id: body.testRunId, status: "QUEUED" },
    data: { status: "RUNNING", startedAt: new Date() },
  });

  if (claim.count === 0) {
    return NextResponse.json({ claimed: false });
  }

  const run = await db.submissionTestRun.findUnique({
    where: { id: body.testRunId },
    select: {
      id: true,
      submissionId: true,
      assignmentId: true,
      submission: { select: { id: true, attachmentId: true } },
      assignment: { select: locatorSelect },
    },
  });

  if (!run) {
    return NextResponse.json({ claimed: false });
  }

  const locator = locatorFrom(run.assignment);
  const [submissionFiles, template] = await Promise.all([
    readSubmission(locator, run.submission.id),
    readSandpackTemplate(locator),
  ]);

  // Runner sees full template + submission overrides on visible paths.
  const mergedTemplate = template
    ? mergeForAudience(template as SandpackTemplate, submissionFiles, "runner")
    : null;
  const mergedFiles = mergedTemplate?.files ?? submissionFiles ?? {};

  return NextResponse.json({
    claimed: true,
    run: {
      id: run.id,
      submissionId: run.submissionId,
      assignmentId: run.assignmentId,
      submission: {
        id: run.submission.id,
        attachmentId: run.submission.attachmentId,
        data: mergedFiles,
      },
      assignment: {
        id: run.assignment.id,
        sandboxTemplate: mergedTemplate
          ? Buffer.from(JSON.stringify(mergedTemplate), "utf-8").toString(
              "base64",
            )
          : null,
      },
    },
  });
}
```

### Associated Dependencies & Helpers (claim)

#### 1. Storage Locator (`packages/api/src/lib/storage-locator.ts`)
Builds multi-tenant tenant paths (`orgId/courseId/assignmentId`) for S3/MinIO:
```typescript
export const locatorSelect = {
  id: true,
  courseId: true,
  course: {
    select: {
      id: true,
      createdBy: { select: { organizationId: true } },
    },
  },
} as const;

export function locatorFrom(row: LocatorRow): Locator {
  return {
    orgId: row.course?.createdBy?.organizationId ?? null,
    courseId: row.courseId,
    assignmentId: row.id,
  };
}
```

#### 2. Template Merging Policy (`packages/api/src/lib/template-policy.ts`)
Ensures students cannot overwrite instructor tests or hidden files:
```typescript
export function mergeForAudience(
  template: SandpackTemplate,
  submissionFiles: Record<string, string> | null,
  audience: "student" | "instructor" | "runner",
): SandpackTemplate {
  const base =
    audience === "student" ? filterTemplateForStudent(template) : template;
  if (!submissionFiles) return base;
  const out: TemplateFiles = { ...(base.files ?? {}) };
  const templateFilesFull = template.files ?? {};
  for (const [path, code] of Object.entries(submissionFiles)) {
    if (isTemplateOnly(path, templateFilesFull[path])) continue;
    out[path] = code;
  }
  return { ...base, files: out };
}
```

### Runner Orchestrator Consumer (`claimRun`)

**File Path:** `apps/runner-orchestrator/src/callback.ts`

```typescript
export type RunFetchResult = {
  claimed: boolean;
  run?: {
    id: string;
    submissionId: string;
    assignmentId: string;
    submission: {
      id: string;
      data: unknown;
      attachmentId: string;
    };
    assignment: {
      id: string;
      sandboxTemplate: string | null;
      hiddenTestFiles: Record<string, string> | null;
    };
  };
};

export async function claimRun(testRunId: string): Promise<RunFetchResult> {
  const url = `${env.WEB_BASE_URL}/api/test-runner/claim`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Service-Token": env.TEST_RUNNER_SECRET,
    },
    body: JSON.stringify({ testRunId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`claim failed: ${res.status} ${text}`);
  }
  return (await res.json()) as RunFetchResult;
}
```

Called inside `apps/runner-orchestrator/src/job.ts`:
```typescript
const claim = await claimRun(testRunId);
if (!claim.claimed || !claim.run) {
  log.info("claim skipped (run not in QUEUED state)");
  return;
}
```

### Deep Dive: Security, Concurrency, and Policy Merging

1. **Constant-Time Authentication:**  
   Uses Node's `timingSafeEqual` against `process.env.TEST_RUNNER_SECRET` passed in the `X-Service-Token` header. Timing attacks cannot deduce the secret byte-by-byte.
2. **Atomic Concurrency Lock (`updateMany`):**  
   Multiple orchestrator workers or concurrent retry jobs can attempt to claim the same `testRunId`. By executing:
   ```typescript
   db.submissionTestRun.updateMany({
     where: { id: body.testRunId, status: "QUEUED" },
     data: { status: "RUNNING", startedAt: new Date() },
   });
   ```
   Only the exact first transaction that transitions the row from `QUEUED` to `RUNNING` receives `claim.count === 1`. All subsequent claims receive `claim.count === 0` and return `{ claimed: false }` immediately without duplicating work.
3. **Defense-in-Depth File Overlay (`mergeForAudience`):**  
   The runner receives the instructor's master template merged with the student's submission files. Because `isTemplateOnly` checks filter out student modifications to test paths (`*.test.ts`, `*.spec.js`) or hidden paths (`/__hidden__/`), a malicious student payload cannot overwrite test assertions.

---

## 3. Component 2: `/api/test-runner/callback`

### Route Handler Source Code (callback)

**File Path:** `apps/web/src/app/api/test-runner/callback/route.ts`

```typescript
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { db } from "@tutly/db";
import { recordTestRunOutcome } from "@tutly/api/lib/test-run-scoring";

function checkSecret(req: NextRequest): boolean {
  const provided = req.headers.get("x-service-token") ?? "";
  const expected = process.env.TEST_RUNNER_SECRET ?? "";
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type CallbackBody = {
  testRunId?: string;
  status?: "PASSED" | "FAILED" | "ERROR";
  results?: Array<{
    testCaseId?: string;
    title: string;
    visibility?: "VISIBLE" | "HIDDEN";
    passed: boolean;
    points?: number;
    durationMs?: number;
    output?: string;
    error?: string;
    metadata?: unknown;
  }>;
  jestReport?: unknown;
  errorMessage?: string;
  logsArtifactId?: string;
  reportArtifactId?: string;
};

export async function POST(req: NextRequest) {
  if (!checkSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: CallbackBody;
  try {
    body = (await req.json()) as CallbackBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.testRunId || !body.status) {
    return NextResponse.json(
      { error: "testRunId and status required" },
      { status: 400 },
    );
  }

  const outcome = await recordTestRunOutcome(db, {
    testRunId: body.testRunId,
    status: body.status,
    results: body.results,
    jestReport: body.jestReport,
    errorMessage: body.errorMessage,
    logsArtifactId: body.logsArtifactId,
    reportArtifactId: body.reportArtifactId,
  });

  if (!outcome.ok) {
    return NextResponse.json({ error: "test run not found" }, { status: 404 });
  }

  return NextResponse.json(outcome);
}
```

### Core Scoring & Persistence Logic (`recordTestRunOutcome`)

**File Path:** `packages/api/src/lib/test-run-scoring.ts`

```typescript
export async function recordTestRunOutcome(
  db: Db,
  input: RecordOutcomeInput,
): Promise<RecordOutcomeResult> {
  const run = await db.submissionTestRun.findUnique({
    where: { id: input.testRunId },
  });
  if (!run) return { ok: false, reason: "not-found" };

  // Idempotency: Ignore callbacks if the run is already completed or canceled
  if (run.status !== "QUEUED" && run.status !== "RUNNING") {
    return { ok: true, idempotent: true, runId: run.id };
  }

  // Handle Runner Infrastructure Errors (OOM, Timeout, Docker Crash)
  if (input.status === "ERROR") {
    await db.submissionTestRun.update({
      where: { id: run.id },
      data: {
        status: "ERROR",
        errorMessage: input.errorMessage ?? "runner error",
        jestReport: (input.jestReport ?? null) as never,
        outputSummary: { results: [], source: "runner-error" } as never,
        logsArtifactId: input.logsArtifactId ?? run.logsArtifactId,
        reportArtifactId: input.reportArtifactId ?? run.reportArtifactId,
        completedAt: new Date(),
      },
    });
    return {
      ok: true,
      idempotent: false,
      runId: run.id,
      score: 0,
      maxScore: 0,
    };
  }

  // Query official AssignmentTestCase definitions for point weighting
  const cases = await db.assignmentTestCase.findMany({
    where: { assignmentId: run.assignmentId },
    select: { id: true, points: true, visibility: true },
  });

  // Calculate score & normalize reported results
  const score = scoreReportedResults(input.results ?? [], cases);
  const visibleResults = score.normalized.filter(
    (r) => r.visibility !== "HIDDEN",
  );
  const hiddenResults = score.normalized.filter(
    (r) => r.visibility === "HIDDEN",
  );
  const completedAt = new Date();

  // 1. Update the Test Run with breakdown and raw Jest report
  await db.submissionTestRun.update({
    where: { id: run.id },
    data: {
      status: input.status,
      visiblePassed: visibleResults.filter((r) => r.passed).length,
      visibleTotal: visibleResults.length,
      hiddenPassed: hiddenResults.filter((r) => r.passed).length,
      hiddenTotal: hiddenResults.length,
      score: score.score,
      maxScore: score.maxScore,
      jestReport: (input.jestReport ?? null) as never,
      errorMessage: null,
      outputSummary: {
        results: score.normalized,
        source: "runner-orchestrator",
      } as never,
      logsArtifactId: input.logsArtifactId ?? run.logsArtifactId,
      reportArtifactId: input.reportArtifactId ?? run.reportArtifactId,
      startedAt: run.startedAt ?? completedAt,
      completedAt,
    },
  });

  // 2. Upsert Point row under category "TESTS" for student gradebook
  await db.point.upsert({
    where: {
      submissionId_category: {
        submissionId: run.submissionId,
        category: "TESTS",
      },
    },
    create: {
      submissionId: run.submissionId,
      category: "TESTS",
      score: score.score,
      maxScore: score.maxScore,
      source: "runner-orchestrator",
      testRunId: run.id,
      feedback:
        input.status === "PASSED" ? "All tests passed." : "Some tests failed.",
      metadata: { trigger: run.trigger } as never,
    },
    update: {
      score: score.score,
      maxScore: score.maxScore,
      source: "runner-orchestrator",
      testRunId: run.id,
      feedback:
        input.status === "PASSED" ? "All tests passed." : "Some tests failed.",
      metadata: { trigger: run.trigger } as never,
    },
  });

  // 3. Upsert SubmissionReview state: AUTO_SCORED if passed, else NEEDS_REVIEW
  await db.submissionReview.upsert({
    where: { submissionId: run.submissionId },
    create: {
      submissionId: run.submissionId,
      assignmentId: run.assignmentId,
      status: input.status === "PASSED" ? "AUTO_SCORED" : "NEEDS_REVIEW",
      autoScore: score.score,
      maxScore: score.maxScore,
      testRunId: run.id,
    },
    update: {
      status: input.status === "PASSED" ? "AUTO_SCORED" : "NEEDS_REVIEW",
      autoScore: score.score,
      maxScore: score.maxScore,
      testRunId: run.id,
    },
  });

  return {
    ok: true,
    idempotent: false,
    runId: run.id,
    score: score.score,
    maxScore: score.maxScore,
  };
}
```

### Runner Orchestrator Consumer (`postResults`)

**File Path:** `apps/runner-orchestrator/src/callback.ts`

```typescript
export async function postResults(body: CallbackBody): Promise<boolean> {
  const url = `${env.WEB_BASE_URL}/api/test-runner/callback`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Token": env.TEST_RUNNER_SECRET,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: text, testRunId: body.testRunId },
        "callback non-2xx",
      );
    }
    return res.ok;
  } catch (err) {
    logger.error({ err, testRunId: body.testRunId }, "callback failed");
    return false;
  }
}
```

Called inside `apps/runner-orchestrator/src/job.ts`:
```typescript
await postResults({
  testRunId,
  status: report.status,
  results: report.results,
  jestReport: report.raw,
  errorMessage: report.errorMessage,
});
```

### Deep Dive: Idempotency, Scoring Engine, and Review Automation

1. **Idempotency Guard:**  
   If a network re-transmit or duplicate callback arrives after a run has already completed (`status !== "QUEUED" && status !== "RUNNING"`), `recordTestRunOutcome` returns `{ ok: true, idempotent: true, runId: run.id }` immediately without overwriting scores or duplicating point entries.
2. **Dynamic Point Weighting (`scoreReportedResults`):**
   - **Explicit Test Cases:** If the instructor configured test cases in `assignmentTestCase`, points are weighted and matched by `testCaseId`.
   - **Single Umbrella Case:** If only 1 test case is configured (e.g. "Assignment Tests - 100pts") but the runner reports 10 tests, points are evenly apportioned (`100 / 10 = 10pts each`).
   - **No Configured Cases:** Defaults to `DEFAULT_TEST_MAX_SCORE = 10` total points distributed across the reported test count.
3. **Three-Table Atomic Sync:**  
   A single callback updates:
   - `SubmissionTestRun`: Raw Jest report, visible/hidden totals, execution duration, and status.
   - `Point`: Category `"TESTS"`, linking back to `testRunId` and giving students direct grade feedback.
   - `SubmissionReview`: Marks status as `"AUTO_SCORED"` if 100% passed, or `"NEEDS_REVIEW"` if any test failed, allowing tutors to inspect failures.

---

## 4. Component 3: Code That Creates & Enqueues `SubmissionTestRun`

### Prisma Schema Definition (`SubmissionTestRun`)

**File Path:** `packages/db/prisma/schema.prisma` (lines 914–956)

```prisma
model SubmissionTestRun {
  id String @id @default(uuid())

  submissionId String
  submission   submission @relation(fields: [submissionId], references: [id], onDelete: Cascade)

  assignmentId String
  assignment   Attachment @relation(fields: [assignmentId], references: [id], onDelete: Cascade)

  serviceConnectionId String?
  serviceConnection   ServiceConnection? @relation(fields: [serviceConnectionId], references: [id])

  provider WorkspaceProviderType   @default(LOCAL)
  status   SubmissionTestRunStatus @default(QUEUED)
  trigger  String                  @default("manual")

  visiblePassed Int @default(0)
  visibleTotal  Int @default(0)
  hiddenPassed  Int @default(0)
  hiddenTotal   Int @default(0)
  score         Int @default(0)
  maxScore      Int @default(0)

  outputSummary Json?   @default("{}")
  jestReport    Json?
  errorMessage  String? @db.Text
  attempt       Int     @default(1)

  triggeredByUserId String?
  triggeredBy       User?   @relation("TestRunTriggeredBy", fields: [triggeredByUserId], references: [id])

  logsArtifactId   String?
  reportArtifactId String?
  startedAt        DateTime?
  completedAt      DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([assignmentId, status])
  @@index([assignmentId, createdAt])
  @@index([submissionId, createdAt])
}
```

---

### HTTP Dispatcher Client (`runner-client.ts`)

**File Path:** `packages/api/src/lib/runner-client.ts`

Whenever a `SubmissionTestRun` is placed in `QUEUED` state, the API calls `enqueueTestRun` or `enqueueTestRunBatch` to inform the orchestrator.

```typescript
import { createLogger } from "@tutly/logger";

const logger = createLogger("api:runner-client");

type EnqueueResult = { ok: boolean; status?: number; error?: string };

const RUNNER_URL = process.env.TEST_RUNNER_URL;
const RUNNER_SECRET = process.env.TEST_RUNNER_SECRET;

async function postRunner(path: string, body: unknown): Promise<EnqueueResult> {
  if (!RUNNER_URL || !RUNNER_SECRET) {
    logger.warn({ path }, "runner url/secret not configured; skipping enqueue");
    return { ok: false, error: "runner-not-configured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  try {
    const res = await fetch(`${RUNNER_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Worker-Secret": RUNNER_SECRET,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, path }, "runner enqueue failed");
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export function enqueueTestRun(testRunId: string) {
  return postRunner("/enqueue", { testRunId });
}

export function enqueueTestRunBatch(testRunIds: string[]) {
  return postRunner("/enqueue-batch", { testRunIds });
}
```

---

### Creation Point A: Student Submission (`auto-submit`)

**File Path:** `packages/api/src/routers/submission.ts` (lines 268–305)  
**Trigger:** Student clicks "Submit Assignment" in an in-browser sandbox assignment (`submissionMode === "SANDBOX"`).

```typescript
      const assignment = await ctx.db.attachment.findUnique({
        where: { id: input.assignmentDetails.id },
        select: { submissionMode: true },
      });

      if (assignment?.submissionMode === "SANDBOX") {
        const run = await ctx.db.submissionTestRun.create({
          data: {
            submissionId: submission.id,
            assignmentId: input.assignmentDetails.id,
            provider: "LOCAL",
            trigger: "auto-submit",
            status: "QUEUED",
            attempt: 1,
            triggeredByUserId: user.id,
            outputSummary: { queued: true } as never,
          },
        });

        await ctx.db.submissionReview.upsert({
          where: { submissionId: submission.id },
          create: {
            submissionId: submission.id,
            assignmentId: input.assignmentDetails.id,
            status: "NEEDS_REVIEW",
            testRunId: run.id,
          },
          update: {
            status: "NEEDS_REVIEW",
            testRunId: run.id,
          },
        });

        void enqueueTestRun(run.id);
      }

      return submission;
```

---

### Creation Point B: Instructor Single Rerun (`instructor-rerun`)

**File Path:** `packages/api/src/routers/testRuns.ts` (lines 167–220)  
**Trigger:** Instructor or TA clicks "Rerun Tests" on a specific student's submission in the review dashboard.

```typescript
  enqueueOfficial: protectedProcedure
    .input(
      z.object({
        submissionId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const submission = await requireSubmissionReadAccess(
        ctx,
        input.submissionId,
      );
      const user = ctx.session?.user;
      if (!user || !canManageAssignment(user, submission.assignment)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only instructors can rerun tests",
        });
      }

      const previousAttempts = await ctx.db.submissionTestRun.count({
        where: { submissionId: submission.id },
      });

      const run = await ctx.db.submissionTestRun.create({
        data: {
          submissionId: submission.id,
          assignmentId: submission.attachmentId,
          provider: "LOCAL",
          trigger: "instructor-rerun",
          status: "QUEUED",
          attempt: previousAttempts + 1,
          triggeredByUserId: user.id,
          outputSummary: { queued: true } as never,
        },
      });

      await ctx.db.submissionReview.upsert({
        where: { submissionId: submission.id },
        create: {
          submissionId: submission.id,
          assignmentId: submission.attachmentId,
          status: "NEEDS_REVIEW",
          testRunId: run.id,
        },
        update: {
          status: "NEEDS_REVIEW",
          testRunId: run.id,
        },
      });

      void enqueueTestRun(run.id);

      return run;
    }),
```

---

### Creation Point C: Bulk Assignment Rerun (`rerun-all`)

**File Path:** `packages/api/src/routers/testRuns.ts` (lines 222–275)  
**Trigger:** Instructor updates tests/templates and triggers "Rerun All Submissions" across the entire class.

```typescript
  rerunAllForAssignment: protectedProcedure
    .input(z.object({ assignmentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const assignment = await requireAssignmentManageAccess(
        ctx,
        input.assignmentId,
      );
      const user = ctx.session.user;

      const recentBulk = await ctx.db.submissionTestRun.count({
        where: {
          assignmentId: assignment.id,
          trigger: "rerun-all",
          createdAt: { gt: new Date(Date.now() - 5 * 60 * 1000) },
        },
      });
      if (recentBulk > 0) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message:
            "A bulk rerun was triggered for this assignment in the last 5 minutes",
        });
      }

      const submissions = await ctx.db.submission.findMany({
        where: { attachmentId: assignment.id },
        select: { id: true, _count: { select: { testRuns: true } } },
      });

      if (submissions.length === 0) {
        return { count: 0 };
      }

      const created = await ctx.db.$transaction(
        submissions.map((submission) =>
          ctx.db.submissionTestRun.create({
            data: {
              submissionId: submission.id,
              assignmentId: assignment.id,
              provider: "LOCAL",
              trigger: "rerun-all",
              status: "QUEUED",
              attempt: submission._count.testRuns + 1,
              triggeredByUserId: user.id,
              outputSummary: { queued: true } as never,
            },
          }),
        ),
      );

      void enqueueTestRunBatch(created.map((run) => run.id));

      return { count: created.length };
    }),
```

---

### Creation Point D: Workspace Artifact with Hidden Tests (`official`)

**File Path:** `packages/api/src/routers/submission.ts` (lines 881–904)  
**Trigger:** Student submits a workspace artifact assignment (via CLI/VS Code) containing server-side hidden tests.

```typescript
      const hiddenCount = await ctx.db.assignmentTestCase.count({
        where: {
          assignmentId: submitted.attachmentId,
          visibility: "HIDDEN",
        },
      });
      if (hiddenCount > 0) {
        await ctx.db.submissionTestRun.create({
          data: {
            submissionId: submitted.id,
            assignmentId: submitted.attachmentId,
            provider: "SSH",
            trigger: "official",
            status: "QUEUED",
            hiddenTotal: hiddenCount,
            outputSummary: {
              trustedRunnerRequired: true,
              reason:
                "Hidden tests stay server-side and are not sent to local workspaces.",
            } as never,
          },
        });
      }
```

---

### Creation Point E: Client-Side Visible Run Recording (`runVisible`)

**File Path:** `packages/api/src/routers/testRuns.ts` (lines 27–165)  
**Trigger:** Student runs visible tests directly in their browser Sandpack editor; results are reported back immediately to create an instant evaluation run (without queuing to orchestrator).

```typescript
  runVisible: protectedProcedure
    .input(
      z.object({
        submissionId: z.string(),
        provider: z.enum(["LOCAL", "SSH"]).default("LOCAL"),
        serviceConnectionId: z.string().optional(),
        trigger: z.string().default("student-visible"),
        logsArtifactId: z.string().optional(),
        reportArtifactId: z.string().optional(),
        results: z.array(reportedTestSchema).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const submission = await requireSubmissionReadAccess(
        ctx,
        input.submissionId,
      );
      const visibleResults = input.results.filter(
        (result) => result.visibility !== "HIDDEN",
      );

      if (visibleResults.length !== input.results.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Hidden test results must be recorded by a trusted runner.",
        });
      }

      const [visibleCases, hiddenCount] = await Promise.all([
        ctx.db.assignmentTestCase.findMany({
          where: {
            assignmentId: submission.attachmentId,
            visibility: "VISIBLE",
          },
          select: { id: true, points: true },
        }),
        ctx.db.assignmentTestCase.count({
          where: {
            assignmentId: submission.attachmentId,
            visibility: "HIDDEN",
          },
        }),
      ]);

      const score = scoreReportedResults(visibleResults, visibleCases);
      const status = score.score >= score.maxScore ? "PASSED" : "FAILED";
      const completedAt = new Date();

      const run = await ctx.db.submissionTestRun.create({
        data: {
          submissionId: submission.id,
          assignmentId: submission.attachmentId,
          serviceConnectionId: input.serviceConnectionId ?? null,
          provider: input.provider,
          trigger: input.trigger,
          status,
          visiblePassed: score.passed,
          visibleTotal: score.total,
          hiddenPassed: 0,
          hiddenTotal: hiddenCount,
          score: score.score,
          maxScore: score.maxScore,
          outputSummary: {
            results: score.normalized,
            source: "visible-agent",
          } as never,
          logsArtifactId: input.logsArtifactId ?? null,
          reportArtifactId: input.reportArtifactId ?? null,
          startedAt: completedAt,
          completedAt,
        },
      });

      // Updates point and review status...
      return run;
    }),
```

---

## 5. Summary Comparison & Architectural Observations

| Component | File Location | Purpose & Execution Characteristics |
| :--- | :--- | :--- |
| **`/api/test-runner/claim`** | `apps/web/src/app/api/test-runner/claim/route.ts` | Authenticated HTTP route (`X-Service-Token`). Performs atomic DB lock (`updateMany` with `status: 'QUEUED'`), retrieves student code & template from S3/MinIO, merges them via `mergeForAudience(..., "runner")`, and returns workspace payload to the worker. |
| **`/api/test-runner/callback`** | `apps/web/src/app/api/test-runner/callback/route.ts` | Authenticated HTTP route (`X-Service-Token`). Ingests test completion report from worker, enforces idempotency, invokes `recordTestRunOutcome` to calculate points against `AssignmentTestCase`, and atomically synchronizes `SubmissionTestRun`, `Point`, and `SubmissionReview`. |
| **`enqueueTestRun` / `enqueueTestRunBatch`** | `packages/api/src/lib/runner-client.ts` | Outbound HTTP client from API to `runner-orchestrator` (`POST /enqueue` or `/enqueue-batch`) with `X-Worker-Secret`. Uses `AbortController` (5s timeout) and non-blocking `void` fire-and-forget. |
| **Auto-Submit Creation** | `packages/api/src/routers/submission.ts` (`createSubmission`) | Creates `SubmissionTestRun` with `trigger: 'auto-submit'`, `status: 'QUEUED'`, `attempt: 1`, attaches it to `SubmissionReview`, and fires `enqueueTestRun(run.id)`. |
| **Instructor Rerun Creation** | `packages/api/src/routers/testRuns.ts` (`enqueueOfficial`) | RBAC-guarded rerun creating `SubmissionTestRun` with `trigger: 'instructor-rerun'`, incrementing `attempt`, and firing `enqueueTestRun(run.id)`. |
| **Bulk Rerun Creation** | `packages/api/src/routers/testRuns.ts` (`rerunAllForAssignment`) | Rate-limited (5-min cooldown) batch creation inside `ctx.db.$transaction`, followed by `enqueueTestRunBatch(runIds)`. |
| **Client Visible Recording** | `packages/api/src/routers/testRuns.ts` (`runVisible`) | Direct evaluation path: creates completed `SubmissionTestRun` immediately from in-browser test execution, rejecting any spoofed hidden test results. |
