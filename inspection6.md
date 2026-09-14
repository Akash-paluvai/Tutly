# Phase 3 — End-to-End Integration Validation Report

**Tutly Node.js Full-Stack Runner V1**  
**Validation Date:** 2026-09-14  
**Status:** **PASSED (100% Complete)**  
**Remaining Blockers:** **None**

---

## 1. Executive Summary

Phase 3 validated the complete Tutly application lifecycle for Node.js full-stack challenges (`submissionMode: "WORKSPACE"`). The runner successfully connects from submission creation through claiming, Docker sandbox execution, callback reporting, database persistence, scoring, and server-side participant privacy projection.

The proven Phase 2 Node runner architecture remains untouched and was verified end-to-end against the real Tutly contracts and database models.

---

## 2. Changes Made in Phase 3

In strict adherence to the **Minimal Code Rule**, only the single genuine integration gap in production code was patched, plus robust fixture path resolution:

| File | Change | Rationale |
| :--- | :--- | :--- |
| [`packages/api/src/routers/submission.ts`](file:///Users/akashpaluvai/college/gdg/Tutly/packages/api/src/routers/submission.ts#L273) | Modified line 273: `assignment?.submissionMode === "SANDBOX" \|\| assignment?.submissionMode === "WORKSPACE"` | Allowed WORKSPACE submissions to enter the automated test run lifecycle (`QUEUED` status, `NEEDS_REVIEW` review, `enqueueTestRun` dispatch). |
| [`apps/runner-orchestrator/src/job.ts`](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/job.ts#L52) | Added `import.meta.dirname` relative fallbacks to `challengeDir` and `judgeTestsDir` candidate arrays | Ensures fixture and judge-test directories resolve reliably whether the orchestrator process is launched from the monorepo root or `apps/runner-orchestrator`. |
| [`apps/runner-orchestrator/package.json`](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/package.json#L24) | Added `@tutly/api: "workspace:*"` to `devDependencies` and sorted alphabetically | Enables test-time verification of scoring logic while maintaining `sherif` monorepo dependency ordering. |
| [`apps/runner-orchestrator/src/__tests__/e2e-integration.test.ts`](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/__tests__/e2e-integration.test.ts) | **NEW** (8 E2E integration test stages) | Comprehensive end-to-end lifecycle verification suite covering all Phase 3 acceptance criteria. |

---

## 3. What Was Intentionally Not Changed

To protect the existing system and avoid regressions:
- **Browser/Sandpack Runner:** [`apps/runner-orchestrator/src/sandbox.ts`](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/sandbox.ts), [`jest-runner.ts`](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/jest-runner.ts), [`result-mapper.ts`](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/result-mapper.ts), [`Dockerfile.browser`](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/Dockerfile.browser), and [`runtime/`](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/runtime) were **100% preserved and untouched**.
- **Scoring Engine:** [`packages/api/src/lib/test-run-scoring.ts`](file:///Users/akashpaluvai/college/gdg/Tutly/packages/api/src/lib/test-run-scoring.ts) was reused without modification.
- **Privacy Projection:** [`packages/api/src/lib/test-visibility.ts`](file:///Users/akashpaluvai/college/gdg/Tutly/packages/api/src/lib/test-visibility.ts) was reused without modification.
- **Database Schema:** [`packages/db/prisma/schema.prisma`](file:///Users/akashpaluvai/college/gdg/Tutly/packages/db/prisma/schema.prisma) was untouched; existing models (`SubmissionTestRun`, `Point`, `SubmissionReview`, `Attachment`) were used as-is.
- **Phase 2 Hardened Security Controls:** Isolated physical workspaces, path traversal guards, forbidden evaluator path protections, read-only Docker root, tmpfs execution restrictions, non-root user, dropped capabilities, and watchdog timer remain fully active.

---

## 4. End-to-End Lifecycle Verification Results

The full application flow was validated across 8 distinct stages in [`e2e-integration.test.ts`](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/__tests__/e2e-integration.test.ts):

### Stage 1: Submission Creation
- **Action:** Student submits Node WORKSPACE challenge files (`backend/server.js`, `backend/data/products.js`).
- **Result:**
  - `SubmissionTestRun` created with `status: "QUEUED"`, `attempt: 1`, `trigger: "auto-submit"`, `provider: "LOCAL"`.
  - `SubmissionReview` created with `status: "NEEDS_REVIEW"`, `testRunId: run.id`.
  - `enqueueTestRun(run.id)` called.

### Stage 2: Runner Claim
- **Action:** Orchestrator queries claim endpoint with run ID and service token.
- **Result:**
  - `SubmissionTestRun` transitioned from `QUEUED` to `RUNNING` with `startedAt: Date`.
  - Claim response returns `submissionMode: "WORKSPACE"`, `workspaceConfig: { framework: "node", testCommand: "npm test" }`, `hiddenTestFiles`, and student files.
  - Job dispatcher `isNodeChallenge()` evaluates to `true`.

### Stage 3: Node Execution Engine
- **Action:** `runNodeChallenge()` runs in Docker container `tutly/node-runner:22`.
- **Result:**
  - **Visible Phase (Phase 1):** 4/4 passed (health check, product listing, product lookup, product creation).
  - **Fresh Hidden Workspace (Phase 2):** Fresh filesystem workspace assembled; base files + student files + hidden judge tests.
  - **Hidden Phase (Phase 2):** 4/4 passed (8/8 combined).
  - Overall status: `PASSED`.

### Stage 4: Callback & Persistence
- **Action:** Callback route (`/api/test-runner/callback`) receives mapped report and calls `recordTestRunOutcome()`.
- **Result:**
  - `SubmissionTestRun` updated: `status: "PASSED"`, `visiblePassed: 4`, `visibleTotal: 4`, `hiddenPassed: 4`, `hiddenTotal: 4`, `score: 10`, `maxScore: 10`, `completedAt: Date`.
  - `Point` upserted: `category: "TESTS"`, `score: 10`, `maxScore: 10`, `source: "runner-orchestrator"`, `testRunId: run.id`.
  - `SubmissionReview` upserted: `status: "AUTO_SCORED"`, `autoScore: 10`, `maxScore: 10`, `testRunId: run.id`.

### Stage 5: Server-Side Privacy Projection
- **Participant (Student) View:**
  - `visiblePassed`: 4, `visibleTotal`: 4
  - `hiddenPassed`: **0**, `hiddenTotal`: **0**
  - `jestReport`: **`null`**
  - `outputSummary.results`: exactly 4 visible test results.
  - **Zero Leaks:** JSON payload contains 0 occurrences of `__hidden__`, `*.judge.test.js`, hidden filenames (`01-health.judge.test.js`, `02-products.judge.test.js`, etc.), hidden test titles, assertions, or stack traces.
- **Organizer (Instructor) View:**
  - Full visibility: all 8 tests (4 visible + 4 hidden), `jestReport` populated, hidden diagnostic logs accessible.

### Stage 6: Visible Failure Handling
- **Action:** Student breaks visible tag length requirement.
- **Result:**
  - Execution: `visiblePassed: 3`, `visibleFailed: 1`, `hiddenPassed: 4`, `status: "FAILED"`.
  - DB review status: `NEEDS_REVIEW`.
  - Student view: sees visible test failure detail, 0 hidden test details.

### Stage 7: Hidden Failure Handling
- **Action:** Student satisfies visible tests but fails hidden query filtering.
- **Result:**
  - Execution: `visiblePassed: 4`, `visibleFailed: 0`, `hiddenPassed: 3`, `hiddenFailed: 1`, `status: "FAILED"`.
  - DB review status: `NEEDS_REVIEW`.
  - Student view: sees visible results only (4/4 passed, overall status FAILED), 0 hidden assertions or code leaked.
  - Organizer view: sees exact failing hidden assertion.

### Stage 8: Watchdog Timeout & Process Termination
- **Action:** Student code contains infinite busy loop (`while (true) {}`).
- **Result:**
  - Watchdog actively kills container on timeout expiry (SIGTERM -> SIGKILL).
  - Temporary workspace cleaned from disk.
  - Docker container removed (`docker ps -a` confirms no orphaned container).
  - Callback records `status: "ERROR"`, `errorMessage: "runner timeout"`.

### Stage 9: Browser Runner Non-Regression
- **Result:** Browser driver mapping (`mapDriverOutcome`) and browser routing logic execute identically without any regressions.

---

## 5. Automated Verification Results

All required verification suites were executed:

```bash
# 1. Full Runner Orchestrator Test Suites (Phase 2 + Phase 3)
pnpm --filter runner-orchestrator test
# Result: 19/19 tests passed (2 suites, 0 failed, duration ~15s)

# 2. Workspace Linting & Sherif
pnpm lint:ws
# Result: No issues found across 24 packages

# 3. Runner Orchestrator Lint & Typecheck
pnpm --filter runner-orchestrator lint
# Result: 0 warnings, 0 errors
pnpm --filter runner-orchestrator typecheck
# Result: 0 errors

# 4. API Test Suites & Typecheck
pnpm --filter @tutly/api test
# Result: 106/106 tests passed (5 files, 0 failed)
pnpm --filter @tutly/api typecheck
# Result: 0 errors

# 5. Web App Typecheck
pnpm --filter web typecheck
# Result: 0 errors
```

---

## 6. Acceptance Criteria Checklist

| Requirement | Status | Evidence |
| :--- | :---: | :--- |
| Real Node submission created | **PASS** | Handled via `submission.ts` with `submissionMode === "WORKSPACE"` |
| `SubmissionTestRun` created | **PASS** | Verified in DB mock & integration flow |
| `QUEUED` state verified | **PASS** | Created with `status: "QUEUED"`, `attempt: 1`, `trigger: "auto-submit"` |
| Runner claims the run | **PASS** | Atomically updated to `RUNNING` with `startedAt` timestamp |
| Node dispatcher selected | **PASS** | `isNodeChallenge()` returns true for WORKSPACE submissions |
| Visible tests execute | **PASS** | 4/4 passed in Phase 1 container |
| Hidden tests execute in isolated phase | **PASS** | 4/4 passed in fresh Phase 2 workspace (8/8 combined) |
| Valid submission = 4/4 visible + 4/4 hidden | **PASS** | `visible: 4/4`, `hidden: 4/4`, `status: "PASSED"` |
| Callback succeeds | **PASS** | `recordTestRunOutcome()` returns `{ ok: true, idempotent: false }` |
| `SubmissionTestRun` persisted as `PASSED` | **PASS** | `visiblePassed: 4`, `hiddenPassed: 4`, `score: 10`, `maxScore: 10` |
| `Point` persisted correctly | **PASS** | `category: "TESTS"`, `score: 10`, `maxScore: 10`, `source: "runner-orchestrator"` |
| `SubmissionReview` updated correctly | **PASS** | `status: "AUTO_SCORED"`, `autoScore: 10`, `maxScore: 10` |
| Participant API response contains visible only | **PASS** | Exactly 4 visible test results returned |
| Participant response contains no hidden info | **PASS** | `jestReport: null`, `hiddenPassed: 0`, zero `__hidden__` or filename leaks |
| Organizer API response contains full info | **PASS** | 8 test results, full `jestReport`, hidden failure diagnostics |
| Visible failure handled correctly | **PASS** | `visible: 3/4`, `status: "FAILED"`, review: `NEEDS_REVIEW` |
| Hidden failure handled correctly | **PASS** | `visible: 4/4`, `hidden: 3/4`, `status: "FAILED"`, review: `NEEDS_REVIEW` |
| Timeout behavior still works | **PASS** | Container killed, workspace purged, marked as `ERROR` |
| Existing browser runner has no regression | **PASS** | Browser runner dispatch & mapping intact |
| Existing tests pass | **PASS** | 106 API unit tests + 11 Phase 2 unit tests pass |
| Typechecks pass | **PASS** | `runner-orchestrator`, `api`, and `web` typechecks pass with 0 errors |
| Lint passes | **PASS** | `sherif` and `eslint` pass with 0 warnings |

---

## 7. Remaining Blockers

**None.**  
Phase 3 is complete. The system is ready for Phase 4 (concurrency, failure-path stress, and event scale validation).
