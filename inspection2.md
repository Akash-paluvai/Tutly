# Tutly Execution Pipeline Audit: Generic vs. Sandpack/Jest-Specific Components

> **Audit Document:** `inspection2.md`  
> **Target Scope:** Complete trace of the execution pipeline from submission trigger to final score persistence:  
> `submission.ts` → `testRuns.ts` → `runner-client.ts` → `runner-orchestrator` → `sandbox.ts` → `jest-runner.ts` → `result-mapper.ts` → `callback.ts` → `test-run-scoring.ts`.  
> **Objective:** Identify exactly what in the pipeline is **universal / language-agnostic** vs. what is **hardcoded to Sandpack, browser iframes, or Jest**.

---

## 1. High-Level Pipeline Architecture & Flow

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       TUTLY EXECUTION PIPELINE                                         │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘

[ 1. SUBMISSION TRIGGER ]
  packages/api/src/routers/submission.ts
  • Receives student files, validates against template (no deletions allowed).
  • Strips hidden & test files (template-policy.ts).
  • Persists student code to S3/MinIO via @tutly/storage.
  • Creates `submission` record.
  • If `submissionMode === "SANDBOX"`, creates `SubmissionTestRun` (QUEUED) and triggers runner.
           │
           ▼
[ 2. TEST RUN DISPATCH ]
  packages/api/src/routers/testRuns.ts
  • Handles official reruns (`enqueueOfficial`, `rerunAllForAssignment`) and visible runs (`runVisible`).
  • Manages test run lifecycle status in DB (`QUEUED`).
           │
           ▼
[ 3. HTTP RUNNER CLIENT ]
  packages/api/src/lib/runner-client.ts
  • Issues authenticated HTTP POST to `runner-orchestrator` (`/enqueue` or `/enqueue-batch`).
  • Payload: `{ testRunId: string }` with header `X-Worker-Secret`.
           │
           ▼
[ 4. ORCHESTRATOR QUEUE & WORKER ]
  apps/runner-orchestrator/src/ (index.ts, queue.ts, job.ts)
  • In-memory concurrency queue (max concurrency limit, default: 2).
  • Worker calls `claimRun(testRunId)` via `callback.ts` (`POST /api/test-runner/claim`).
  • Atomically transitions test run from `QUEUED` to `RUNNING`.
  • Receives: student submission code, teacher template, and hidden test files.
           │
           ▼
[ 5. WORKSPACE ASSEMBLY ]
  apps/runner-orchestrator/src/sandbox.ts
  • Creates ephemeral directory `/tmp/tutly-runner/run-<id>-<timestamp>`.
  • Layer 1: Writes teacher template files.
  • Layer 2: Overlays student submission files.
  • Layer 3: Re-applies teacher visible test files (Anti-Tamper defense).
  • Layer 4: Writes hidden test files into `/__hidden__/`.
  • Layer 5: Writes `manifest.json` for the runtime driver.
           │
           ▼
[ 6. CONTAINERIZED TEST EXECUTION ]
  apps/runner-orchestrator/src/jest-runner.ts
  • Spawns hardened Docker container (`ghcr.io/tutlylabs/tutly-browser-runner`).
  • Read-only rootfs, tmpfs `/tmp`, memory cap (640MB), CPU cap (1.0), `cap-drop=ALL`.
  • Mounts workspace at `/work:rw`.
  • Container launches `driver.mjs` → Headless Chromium via Playwright.
  • Playwright loads Sandpack client inside an iframe, executes `run-all-tests`.
  • Writes output to `/work/results.json`.
           │
           ▼
[ 7. RESULT NORMALIZATION ]
  apps/runner-orchestrator/src/result-mapper.ts
  • Parses `results.json` from the driver.
  • Detects `__hidden__` prefix on test paths → marks `visibility: "HIDDEN"`.
  • Converts Sandpack test blocks/names into normalized `MappedTest[]`.
  • Formats status (`PASSED` | `FAILED` | `ERROR`) and failure stacks.
           │
           ▼
[ 8. RESULTS CALLBACK ]
  apps/runner-orchestrator/src/callback.ts & apps/web/src/app/api/test-runner/callback/route.ts
  • Posts normalized results back to Web API: `POST /api/test-runner/callback`.
  • Validates service token, unlocks database transaction.
           │
           ▼
[ 9. SCORING, POINTS & REVIEWS ]
  packages/api/src/lib/test-run-scoring.ts
  • Matches reported results against rubric `AssignmentTestCase` in DB.
  • Calculates final score (normalizes to 10 if no explicit cases defined).
  • Updates `SubmissionTestRun`: `visiblePassed`, `hiddenPassed`, `score`, `outputSummary`.
  • Upserts `Point` record (`category: "TESTS"`).
  • Upserts `SubmissionReview` (`AUTO_SCORED` or `NEEDS_REVIEW`).
```

---

## 2. File-by-File Detailed Audit

---

### Step 1: `submission.ts`
* **File:** [packages/api/src/routers/submission.ts](file:///Users/akashpaluvai/college/gdg/Tutly/packages/api/src/routers/submission.ts)
* **Function/Procedure:** `submission.submit` mutation (L145–L305)

#### What It Does:
1. Validates user enrollment and assignment submission limits (`maxSubmissions`).
2. Loads the assignment's base template from S3/MinIO storage via `readSandpackTemplate(locator)`.
3. Verifies that the student did not delete required template files (`findDeletedTemplatePaths`).
4. Strips template-only files (hidden files and test files) via `filterSubmissionInput(submittedRaw, template)`.
5. Persists student code to S3/MinIO under `org/.../submissions/<submissionId>/...`.
6. Creates the Postgres `submission` row.
7. If `assignment.submissionMode === "SANDBOX"`, creates a `SubmissionTestRun` row in `QUEUED` state, creates a `SubmissionReview` in `NEEDS_REVIEW`, and triggers `enqueueTestRun(run.id)`.

#### Inputs & Outputs:
* **Input:**
  ```typescript
  {
    assignmentDetails: { id: string, maxSubmissions: number, ... },
    files: SandpackFiles // Record<string, string | { code: string }>
  }
  ```
* **Output:** Created `submission` database entity.

#### Generic vs. Sandpack/Jest-Specific:
| Aspect | Classification | Details |
| :--- | :--- | :--- |
| **Auth & Enrollment verification** | **GENERIC** | Language-agnostic user and deadline checks. |
| **Submission persistence in S3** | **GENERIC** | Keyed by org/course/assignment/submission ID. |
| **Submission & Event record creation** | **GENERIC** | Core DB tables. |
| **Queue dispatch** | **GENERIC** | Creates `SubmissionTestRun` with `QUEUED` and triggers orchestrator. |
| **Input Schema** | **SANDPACK-SPECIFIC** | Expects `sandpackFilesSchema` (`Record<string, string \| { code: string }>`). |
| **Template Loading** | **SANDPACK-SPECIFIC** | Calls `readSandpackTemplate` expecting a Sandpack template sidecar (`tutly.json`). |
| **File Filtering Regex** | **JEST-SPECIFIC** | `template-policy.ts` uses `/\.(test|spec)\.[tj]sx?$/i` to identify tests. Fails to identify Python (`test_*.py`), C++ (`*_test.cpp`), Java (`*Test.java`), Go (`*_test.go`). |
| **Mode Check** | **SANDPACK-SPECIFIC** | Explicitly checks `assignment.submissionMode === "SANDBOX"`. Bypasses automatic runner enqueue for `WORKSPACE` mode! |

---

### Step 2: `testRuns.ts`
* **File:** [packages/api/src/routers/testRuns.ts](file:///Users/akashpaluvai/college/gdg/Tutly/packages/api/src/routers/testRuns.ts)
* **Procedures:** `runVisible`, `enqueueOfficial`, `rerunAllForAssignment`, `getForSubmission`

#### What It Does:
1. `runVisible`: Accepts in-browser student test results. Strictly rejects any result claiming `visibility: "HIDDEN"` (`"Hidden test results must be recorded by a trusted runner"`). Evaluates score and upserts points.
2. `enqueueOfficial`: Allows instructors to re-run the official containerized test suite for a student. Increments `attempt` counter, marks run `QUEUED`, and dispatches to orchestrator.
3. `rerunAllForAssignment`: Allows bulk rerun of all submissions for an assignment.
4. `getForSubmission`: Returns test runs for a submission, protected by `projectTestRunForViewer` (strips hidden test results and failure logs for students).

#### Inputs & Outputs:
* **Input (`runVisible`):**
  ```typescript
  {
    submissionId: string,
    provider: "LOCAL" | "SSH",
    results: Array<{
      testCaseId?: string,
      title: string,
      visibility: "VISIBLE" | "HIDDEN",
      passed: boolean,
      points?: number,
      durationMs?: number,
      output?: string,
      error?: string
    }>
  }
  ```
* **Output:** `SubmissionTestRun` entity.

#### Generic vs. Sandpack/Jest-Specific:
| Aspect | Classification | Details |
| :--- | :--- | :--- |
| **Test Run Data Model** | **GENERIC** | `ReportedTest` schema (`title`, `passed`, `points`, `durationMs`, `error`) is completely language-agnostic. |
| **Permission Checks & RBAC** | **GENERIC** | Verifies assignment read/manage permissions. |
| **Attempt Tracking** | **GENERIC** | Tracks retry count (`attempt: number`). |
| **Batch Processing** | **GENERIC** | Bulk re-enqueues jobs in transactions. |
| **Privacy Protection** | **GENERIC** | `projectTestRunForViewer` masks hidden test details regardless of language. |
| **Runner Dispatch** | **GENERIC** | Dispatches via `enqueueTestRun`. |

*Note: `testRuns.ts` is **100% GENERIC**. It has no dependencies on Sandpack or Jest.*

---

### Step 3: `runner-client.ts`
* **File:** [packages/api/src/lib/runner-client.ts](file:///Users/akashpaluvai/college/gdg/Tutly/packages/api/src/lib/runner-client.ts)
* **Functions:** `enqueueTestRun(testRunId)`, `enqueueTestRunBatch(testRunIds)`

#### What It Does:
1. Reads `TEST_RUNNER_URL` and `TEST_RUNNER_SECRET`.
2. Sends HTTP POST with a 5-second AbortController timeout.
3. Attaches header `X-Worker-Secret: RUNNER_SECRET`.
4. Transmits `{ testRunId }` to `/enqueue` or `{ testRunIds }` to `/enqueue-batch`.

#### Inputs & Outputs:
* **Input:** `testRunId: string` or `testRunIds: string[]`.
* **Output:** `Promise<{ ok: boolean, status?: number, error?: string }>`.

#### Generic vs. Sandpack/Jest-Specific:
| Aspect | Classification | Details |
| :--- | :--- | :--- |
| **HTTP Dispatch** | **100% GENERIC** | Pure RPC notification mechanism. Completely decoupled from test framework, programming language, or code contents. |

---

### Step 4: `runner-orchestrator` (Service)
* **Files:**
  * [apps/runner-orchestrator/src/index.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/index.ts)
  * [apps/runner-orchestrator/src/queue.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/queue.ts)
  * [apps/runner-orchestrator/src/job.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/job.ts)

#### What It Does:
1. **Express Server & Health (`index.ts`):** Exposes `/enqueue`, `/enqueue-batch`, `/health`, and `/dashboard`. Validates `x-worker-secret` via timing-safe string comparison.
2. **Reaper / Failure Recovery (`index.ts`):**
   * On boot, marks any abandoned `RUNNING` jobs in the DB as `ERROR` (`runner restarted while job was in flight`).
   * Re-enqueues recent `QUEUED` jobs.
   * Runs a periodic background interval (every 5 min) reaping jobs stuck in `RUNNING` for > 15 minutes.
3. **In-Memory Queue (`queue.ts`):** Maintains `pending` jobs and `active` set. Concurrency is governed by `env.CONCURRENCY` (default 2).
4. **Job Pipeline (`job.ts`):**
   * Calls `claimRun(testRunId)` (`POST /api/test-runner/claim`).
   * Invokes `assembleWorkspace(...)` from `sandbox.ts`.
   * Invokes `runJest(cwd)` from `jest-runner.ts`.
   * Invokes `postResults(...)` to report results.
   * Runs `cleanupWorkspace(cwd)` in `finally` block to delete temporary files.

#### Generic vs. Sandpack/Jest-Specific:
| Aspect | Classification | Details |
| :--- | :--- | :--- |
| **Queue Management** | **GENERIC** | Concurrency control, deduplication, active sets. |
| **Authentication & Health** | **GENERIC** | Secret comparison, health status endpoints. |
| **Crash Recovery & Reaper** | **GENERIC** | Database reconciliation of stale/orphaned runs. |
| **Job Lifecycle Management** | **GENERIC** | Claim → Assemble → Execute → Post Results → Cleanup. |
| **Docker Pre-pull** | **BROWSER-SPECIFIC** | `pullJestImage()` hardcodes pulling `env.BROWSER_IMAGE`. |
| **Execution Dispatch** | **JEST/SANDPACK-SPECIFIC** | `job.ts` directly imports and executes `assembleWorkspace` and `runJest`. There is no runner registry or runtime selector (e.g. choosing between Python, Node, Browser). |

---

### Step 5: `sandbox.ts`
* **File:** [apps/runner-orchestrator/src/sandbox.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/sandbox.ts)
* **Function:** `assembleWorkspace(opts)`

#### What It Does:
1. Creates a physical directory: `WORK_DIR/run-<testRunId>-<timestamp>`.
2. Sets directory permissions (`chmod 0o777`).
3. Decodes the base64 `sandboxTemplate` JSON.
4. Performs 4-step file composition:
   * **Step A:** Writes template files (skipping `entry.hidden === true`).
   * **Step B:** Overlays student submission files (`submissionData`).
   * **Step C (Anti-Tamper):** Re-writes template visible test files (`\.(test|spec)\.[tj]sx?$`) over the student files.
   * **Step D (Hidden Tests):** Injects hidden test files under `/__hidden__/`.
5. Writes individual files to disk using path traversal defense (`safeJoin` rejecting `..` and null bytes).
6. Generates `manifest.json` containing template name, options, and `{ [path]: { code } }`.

#### Inputs & Outputs:
* **Input:**
  ```typescript
  {
    testRunId: string,
    submissionData: unknown, // Record<string, SandpackFile>
    sandboxTemplate: string | null, // base64 encoded SandpackTemplate JSON
    hiddenTestFiles: Record<string, string> | null
  }
  ```
* **Output:**
  ```typescript
  {
    cwd: string,
    visibleTestPaths: string[],
    hiddenTestPaths: string[]
  }
  ```

#### Generic vs. Sandpack/Jest-Specific:
| Aspect | Classification | Details |
| :--- | :--- | :--- |
| **Ephemeral Directory Creation** | **GENERIC** | Isolated disk workspace per test run. |
| **Path Traversal Protection** | **GENERIC** | `safeJoin` guarantees files cannot escape the workspace directory. |
| **Multi-Layer Merge Architecture** | **GENERIC CONCEPT** | Base template → student overlay → anti-tamper test restore → hidden test injection is an ideal design for all languages. |
| **Template Decoding** | **SANDPACK-SPECIFIC** | Expects base64-encoded `SandpackTemplate` JSON. |
| **Input Data Shape** | **SANDPACK-SPECIFIC** | Assumes `submissionData` is a Sandpack key-value file map, not a zip, tarball, or git repo. |
| **Test Detection Regex** | **JEST-SPECIFIC** | Uses `TEST_FILE_REGEX = /\.(test|spec)\.[tj]sx?$/` to find visible tests to restore. |
| **Output Manifest** | **SANDPACK-SPECIFIC** | Writes `manifest.json` formatted specifically for `@codesandbox/sandpack-client`. |

---

### Step 6: `jest-runner.ts` (and Browser Driver Runtime)
* **Files:**
  * [apps/runner-orchestrator/src/jest-runner.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/jest-runner.ts)
  * [apps/runner-orchestrator/runtime/driver.mjs](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/runtime/driver.mjs)
  * [apps/runner-orchestrator/runtime/index.html](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/runtime/index.html)
  * [apps/runner-orchestrator/Dockerfile.browser](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/Dockerfile.browser)

#### What It Does:
1. `jest-runner.ts` validates that `cwd` is inside `WORK_DIR`.
2. Assembles Docker command with security hardening:
   * `--read-only`, `--tmpfs /tmp:rw,noexec,nosuid,size=128m`
   * `--memory=640m`, `--memory-swap=640m`, `--cpus=1.0`, `--pids-limit=128`
   * `--security-opt=no-new-privileges`, `--cap-drop=ALL`
   * Volume mounts host workspace: `-v hostCwd:/work:rw`
   * Image: `env.BROWSER_IMAGE` (`mcr.microsoft.com/playwright:v1.60.0-noble` base)
3. Spawns Docker process with a timeout timer (`JOB_TIMEOUT_MS`).
4. **Inside Docker (`driver.mjs`):**
   * Express static server serves offline Sandpack bundler assets and `/work/manifest.json`.
   * Playwright launches headless Chromium.
   * Navigates to `http://127.0.0.1:8000/index.html`.
5. **Inside Browser (`index.html`):**
   * Embeds Sandpack client in an iframe.
   * Bundles files in memory via service workers and client Babel.
   * Listens for Sandpack events: `initialize_tests`, `test_end`, `total_test_end`, `file_error`.
   * Dispatches `client.dispatch({ type: "run-all-tests" })`.
   * Extracts `window.__results` and writes to `/work/results.json`.
6. `jest-runner.ts` reads `/work/results.json` and invokes `mapDriverOutcome`.

#### Generic vs. Sandpack/Jest-Specific:
| Aspect | Classification | Details |
| :--- | :--- | :--- |
| **Docker Security Sandbox** | **GENERIC** | Read-only root, memory/CPU caps, tmpfs, dropped caps, and volume mount are the gold standard for **any** language execution sandbox. |
| **Process Management & Killing** | **GENERIC** | Subprocess timeout handling, `docker kill <containerName>`, buffer tail capturing. |
| **Browser Runner Execution** | **100% SANDPACK/BROWSER-SPECIFIC** | Spawning Playwright, running Chromium, embedding Sandpack client in an iframe, and listening to CodeSandbox WebSocket/postMessage events is completely specific to browser-based frontend test execution. |
| **Test Dispatch Mechanism** | **SANDPACK-SPECIFIC** | `client.dispatch({ type: "run-all-tests" })` is Sandpack's internal client protocol. |

---

### Step 7: `result-mapper.ts`
* **File:** [apps/runner-orchestrator/src/result-mapper.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/result-mapper.ts)
* **Function:** `mapDriverOutcome(outcome: DriverOutcome): MappedReport`

#### What It Does:
1. Inspects raw output from `results.json`.
2. Handles crash scenarios: `bootError`, `timedOut`, `pageErrors`, compile errors.
3. Detects test visibility:
   ```typescript
   const HIDDEN_PREFIX = "__hidden__";
   function visibilityFor(path: string): "VISIBLE" | "HIDDEN" {
     const norm = path.startsWith("/") ? path.slice(1) : path;
     return norm.startsWith(HIDDEN_PREFIX) ? "HIDDEN" : "VISIBLE";
   }
   ```
4. Formats titles: `${path} > ${describeBlocks.join(" > ")} > ${testName}`.
5. Formats errors and failure messages.
6. Determines overall status: `PASSED` (if 100% passed), `FAILED` (if any failed), or `ERROR`.

#### Inputs & Outputs:
* **Input:** `DriverOutcome` (Sandpack browser client dump with `testsByPath`, `fileErrors`, `pageErrors`).
* **Output:**
  ```typescript
  export type MappedReport = {
    status: "PASSED" | "FAILED" | "ERROR";
    results: Array<{
      testCaseId?: string;
      title: string;
      visibility: "VISIBLE" | "HIDDEN";
      passed: boolean;
      durationMs?: number;
      error?: string;
    }>;
    errorMessage?: string;
    raw: DriverOutcome;
  };
  ```

#### Generic vs. Sandpack/Jest-Specific:
| Aspect | Classification | Details |
| :--- | :--- | :--- |
| **Output Report Structure (`MappedReport`)** | **GENERIC** | The output interface is an ideal universal test IR (status, normalized tests with title, visibility, pass/fail, duration, error). |
| **Visibility Classification** | **GENERIC** | Classifying visibility by path convention (`__hidden__`) works across any test runner or language. |
| **Status Rollup Logic** | **GENERIC** | Rollup of overall test outcome. |
| **Input Schema (`DriverOutcome`)** | **SANDPACK/JEST-SPECIFIC** | Deeply coupled to Sandpack's data model (`SandpackTest`, `blocks`, `matcherResult`, `mappedErrors`, `noTestsInManifest`). |

---

### Step 8: `callback.ts` & Web API Callback Routes
* **Files:**
  * [apps/runner-orchestrator/src/callback.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/callback.ts)
  * [apps/web/src/app/api/test-runner/claim/route.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/src/app/api/test-runner/claim/route.ts)
  * [apps/web/src/app/api/test-runner/callback/route.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/src/app/api/test-runner/callback/route.ts)

#### What It Does:
1. `claimRun`: Orchestrator calls `POST /api/test-runner/claim` with `testRunId`. Web app atomically updates `status: "QUEUED" → "RUNNING"`, reads files from storage, merges them for the runner (`mergeForAudience(..., "runner")`), and returns the payload.
2. `postResults`: Orchestrator calls `POST /api/test-runner/callback` with `CallbackBody`. Web app validates secret and invokes `recordTestRunOutcome`.

#### Generic vs. Sandpack/Jest-Specific:
| Aspect | Classification | Details |
| :--- | :--- | :--- |
| **Atomic Claim Protocol** | **GENERIC** | Prevents multiple workers from running the same job. |
| **Authentication Handshake** | **GENERIC** | `X-Service-Token` constant-time verification. |
| **Results Payload Structure** | **GENERIC** | Universal test array payload. |
| **Claim Payload Naming** | **SANDPACK-SPECIFIC** | `claim/route.ts` specifically reads `readSandpackTemplate`, calls `mergeForAudience`, and returns field named `sandboxTemplate`. |
| **Callback Payload Naming** | **JEST-SPECIFIC** | Uses field name `jestReport` in the callback JSON body. |

---

### Step 9: `test-run-scoring.ts`
* **File:** [packages/api/src/lib/test-run-scoring.ts](file:///Users/akashpaluvai/college/gdg/Tutly/packages/api/src/lib/test-run-scoring.ts)
* **Functions:** `scoreReportedResults(results, cases)`, `recordTestRunOutcome(db, input)`

#### What It Does:
1. **Scoring (`scoreReportedResults`):**
   * If assignment has 1 rubric `AssignmentTestCase` in DB and tests have no explicit points: divides points evenly across all test results.
   * If assignment has 0 test cases in DB: normalizes total score to `DEFAULT_TEST_MAX_SCORE = 10`.
   * If explicit test cases exist: matches by `testCaseId` or awards 1 point per test.
2. **Database Updates (`recordTestRunOutcome`):**
   * Updates `SubmissionTestRun`:
     - `status`: `input.status` (`PASSED`, `FAILED`, or `ERROR`)
     - `visiblePassed`, `visibleTotal`, `hiddenPassed`, `hiddenTotal`
     - `score`, `maxScore`
     - `outputSummary`: `{ results: score.normalized, source: "runner-orchestrator" }`
     - `jestReport`: raw runner report
     - `completedAt`: current timestamp
   * Upserts `Point` record:
     - `category: "TESTS"`, `score`, `maxScore`, `testRunId`
   * Upserts `SubmissionReview`:
     - Sets status: `AUTO_SCORED` (if passed with 0 hidden tests) or `NEEDS_REVIEW`.

#### Generic vs. Sandpack/Jest-Specific:
| Aspect | Classification | Details |
| :--- | :--- | :--- |
| **Score Normalization & Allocation** | **100% GENERIC** | Completely language-agnostic math. Works identically for Python, C++, or JavaScript. |
| **Rubric Mapping (`AssignmentTestCase`)** | **100% GENERIC** | Matches arbitrary test cases by ID or normalized title. |
| **Database Entity Updates** | **100% GENERIC** | Updates `SubmissionTestRun`, `Point`, and `SubmissionReview`. |
| **Audit Log Trail** | **100% GENERIC** | Tracks timestamps, error messages, and artifacts. |
| **Field Naming** | **JEST-SPECIFIC (Trivial)** | The field storing the raw dump is named `jestReport`. |

---

## 3. Side-by-Side Comparison Matrix

| Pipeline Stage | Component / File | What is Generic | What is Sandpack/Jest-Specific |
| :--- | :--- | :--- | :--- |
| **1. Trigger** | `submission.ts` | Submission lifecycle, enrollment validation, S3 persistence, DB row creation, event dispatch. | Expects `SandpackFiles` map; hardcoded `isTestPath` regex for JS/TS; requires `submissionMode === "SANDBOX"`. |
| **2. Router** | `testRuns.ts` | TRPC procedures, permissions, attempt counts, visible run scoring, privacy projection (`projectTestRunForViewer`). | None. (100% Generic). |
| **3. Client** | `runner-client.ts` | HTTP POST dispatch with secret and timeout. | None. (100% Generic). |
| **4. Orchestrator** | `index.ts`, `queue.ts`, `job.ts` | Express server, concurrency queue, crash recovery, reaper, job lifecycle (claim → execute → callback → cleanup). | Hardcoded invocation of `runJest`; pre-pulls `BROWSER_IMAGE`. |
| **5. Sandbox** | `sandbox.ts` | Workspace directory creation, path traversal defense (`safeJoin`), multi-layer merge architecture. | Base64 `SandpackTemplate` decode; in-memory Sandpack files map; `manifest.json` generation; JS test file regex. |
| **6. Execution** | `jest-runner.ts` & runtime | Docker cgroup security limits (read-only, memory, CPU, caps, tmpfs, volume mounts), process killing. | Headless Playwright + Chromium; internal Express server; Sandpack client iframe; in-browser DOM test runner. |
| **7. Mapper** | `result-mapper.ts` | Universal report structure (`MappedReport`, `MappedTest`), `__hidden__` visibility detection, status rollup. | Input is Sandpack `DriverOutcome` (`testsByPath`, `blocks`, `matcherResult`, `pageErrors`). |
| **8. Callback** | `callback.ts` | Service token authentication, atomic claim protocol, error logging. | Payload expects `sandboxTemplate`; callback payload field named `jestReport`. |
| **9. Scoring** | `test-run-scoring.ts` | Scoring algorithm, normalization to 10 points, DB updates to `SubmissionTestRun`, `Point`, `SubmissionReview`. | Column/field named `jestReport`. |

---

## 4. Key Architectural Insights for Multi-Language Support

If we want Tutly to support **backend, algorithmic, or multi-language execution** (e.g. Python, C++, Go, Vitest, Java):

### What We Can Keep As-Is (Zero Changes Needed):
1. **`testRuns.ts`:** The TRPC router already accepts and returns generic test results.
2. **`runner-client.ts`:** The HTTP dispatch mechanism is already generic.
3. **`test-run-scoring.ts`:** The grading and scoring algorithm is already generic.
4. **`projectTestRunForViewer`:** Privacy projection for visible vs. hidden tests is already generic.
5. **Docker Security Sandbox (`jest-runner.ts`):** The Docker cgroup isolation parameters (`--read-only`, `--tmpfs`, `--memory`, `--cpus`, `--cap-drop=ALL`) are already the exact right configuration for running arbitrary untrusted code.
6. **Hidden Test Conventions:** The `/__hidden__/` path convention and `visibilityFor` classification are completely language-agnostic.

### What Needs Decoupling / Abstraction:

#### 1. In `submission.ts`:
* Allow `submissionMode === "WORKSPACE"` or `"CHALLENGE"` to also trigger test execution via `enqueueTestRun`.
* Generalize test file detection beyond `\.(test|spec)\.[tj]sx?$` to support:
  - Python: `test_*.py`, `*_test.py`
  - C/C++: `*_test.cpp`, `test_*.c`
  - Go: `*_test.go`
  - Java: `*Test.java`

#### 2. In `runner-orchestrator`:
* **Runner Strategy Pattern:** In `job.ts`, instead of directly calling `assembleWorkspace` + `runJest`, inspect the assignment/submission configuration and delegate to a **Runner Strategy**:
  ```typescript
  interface RunnerStrategy {
    assemble(run: ClaimedRun): Promise<{ cwd: string }>;
    execute(cwd: string): Promise<RawRunOutcome>;
    map(outcome: RawRunOutcome): MappedReport;
  }
  ```
  - `BrowserSandpackRunner` (the existing Playwright + Chromium implementation for frontend UI/React/Vue assignments)
  - `CliProcessRunner` (for CLI / backend / algorithmic tasks: Python, Node, C++, Go)
* **Workspace Assembly:**
  - Support extracting starter/solution files from disk zips or directory trees instead of requiring a base64 Sandpack template JSON.
* **Docker Image Selection:**
  - For browser tasks: `ghcr.io/tutlylabs/tutly-browser-runner` (Playwright + Chromium).
  - For Python tasks: A lightweight Python image (e.g. `python:3.12-slim` + `pytest`).
  - For Multi-language algorithmic tasks: A unified sandbox image (e.g. Ubuntu with GCC, Python, Node, OpenJDK) executing a standardized test runner.
