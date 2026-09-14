# Architecture Audit & Comparison: Node Runner POC vs. Tutly Production Pipeline

> **Document:** `inspection4.md`  
> **Target Systems:**  
> 1. Reference Implementation (POC): `~/college/gdg/Questions` (`node-runner-poc`, `challenge-001`, `submissions`)  
> 2. Production Monorepo: `~/college/gdg/Tutly` (`apps/runner-orchestrator`, `apps/web`, `packages/api`, `packages/db`, `packages/storage`)  
> **Audited Date:** September 14, 2026  
> **Status:** Phase 1 Inspection & Architecture Comparison (NO CODE MODIFIED)

---

## Table of Contents

1. [Executive Summary & Constraints](#1-executive-summary--constraints)
2. [Verified Repository States & Sanity Checks](#2-verified-repository-states--sanity-checks)
3. [The 8 Core Responsibilities: POC Source Files vs. Tutly Target Architecture](#3-the-8-core-responsibilities-poc-source-files-vs-tutly-target-architecture)
   - [Responsibility 1: Submission Handling](#responsibility-1-submission-handling)
   - [Responsibility 2: Workspace Creation](#responsibility-2-workspace-creation)
   - [Responsibility 3: Visible Tests](#responsibility-3-visible-tests)
   - [Responsibility 4: Hidden / Judge-Only Tests](#responsibility-4-hidden--judge-only-tests)
   - [Responsibility 5: Docker Execution & Container Hardening](#responsibility-5-docker-execution--container-hardening)
   - [Responsibility 6: Jest Execution](#responsibility-6-jest-execution)
   - [Responsibility 7: Result Parsing & Normalization](#responsibility-7-result-parsing--normalization)
   - [Responsibility 8: Cleanup & Resource Lifecycle](#responsibility-8-cleanup--resource-lifecycle)
4. [Architecture Comparison Matrix](#4-architecture-comparison-matrix)
5. [Deep Dive: Reference POC Implementation (`~/college/gdg/Questions`)](#5-deep-dive-reference-poc-implementation)
   - [Directory Layout & Role Breakdown](#directory-layout--role-breakdown)
   - [Two-Phase Execution Model (`visible` then `hidden`)](#two-phase-execution-model)
   - [Container Base Image Optimization (`tutly/node-runner:22`)](#container-base-image-optimization)
   - [Empirical POC Test Run Verification](#empirical-poc-test-run-verification)
6. [Deep Dive: Existing Tutly Execution Architecture (`~/college/gdg/Tutly`)](#6-deep-dive-existing-tutly-execution-architecture)
   - [Existing Browser/Sandpack Runner (PRESERVE INTACT)](#existing-browsersandpack-runner)
   - [Database Entities Available for Reuse](#database-entities-available-for-reuse)
   - [Server-Side Test Visibility Redaction (`projectTestRunForViewer`)](#server-side-test-visibility-redaction)
   - [Queueing & 200-Participant Scalability Analysis](#queueing--200-participant-scalability-analysis)
7. [Gap Analysis](#7-gap-analysis)
8. [Target Architecture & Proposed Node Runner V1 Design](#8-target-architecture--proposed-node-runner-v1-design)
9. [Phased Implementation Roadmap](#9-phased-implementation-roadmap)

---

## 1. Executive Summary & Constraints

Tutly is preparing for a live coding event with approximately **200 participants**. The event challenge is **strictly Node.js full-stack**:
- **NO Django support.**
- **NO generic multi-language judge.**
- **NO rewriting or discarding the existing Tutly architecture.**
- **DO NOT touch, remove, or rewrite the existing browser/Sandpack runner.** The browser runner (`Dockerfile.browser`, `driver.mjs`, `jest-runner.ts`) is proven and remains intact for browser/frontend sandboxes.
- The Node.js execution path will be built as an **isolated, dedicated evaluator** inside `apps/runner-orchestrator`.
- The reference POC in `~/college/gdg/Questions` is the **proven source of truth** for execution, file isolation, Jest parsing, and hidden test separation.

---

## 2. Verified Repository States & Sanity Checks

Executing inspection commands across both repositories:

```bash
cd ~/college/gdg

===== TUTLY =====
cd Tutly
git status --short
 M Makefile
 M package.json
 M packages/db/prisma/seed/index.ts
 M pnpm-lock.yaml
?? inspection.md
?? inspection2.md
?? inspection3.md
git branch --show-current
main

===== QUESTIONS / POC =====
cd ../questions (Questions/)
# Note: Questions/ is a local development directory containing challenge-001, node-runner-poc, submissions.

===== DOCKER IMAGES AVAILABLE LOCALLY =====
tutly/node-runner:22                    (Image ID: 2e201eed5976, Size: 427MB)
ghcr.io/tutlylabs/tutly-browser-runner   (Image ID: e291d2886d26, Size: 3.98GB)
```

---

## 3. The 8 Core Responsibilities: POC Source Files vs. Tutly Target Architecture

The following table and subsections map each core responsibility from its exact POC file to its designated home in Tutly.

| # | Responsibility | Exact POC File(s) | Tutly Target Location | Architectural Role in Tutly |
|---|---|---|---|---|
| **1** | **Submission Handling** | `node-runner-poc/server.js` (`POST /api/judge`) | `packages/api/src/routers/submission.ts` & `apps/web/src/app/api/test-runner/claim/route.ts` | Validates submitted files, enforces size limits and forbidden paths, stores files in S3/MinIO, generates `SubmissionTestRun`, and delivers payload on runner claim. |
| **2** | **Workspace Creation** | `node-runner-poc/runner/runner.js` (`copySubmission`, `copyVisibleTests`, `copyPackageFiles`) | `apps/runner-orchestrator/src/node-sandbox.ts` | Creates disk directory under `/tmp/tutly-runner/run-<id>`, checks path traversal, copies student files, and injects starter `package.json` + `tests/`. |
| **3** | **Visible Tests** | `challenge-001/tests/product.visible.test.js` & `challenge-001/challenge.json` | S3 / Challenge Definition + `AssignmentTestCase` (`visibility: "VISIBLE"`) | Participant-facing test suite. Shown in the IDE; executed in Phase 1 (`npm test`). |
| **4** | **Hidden Tests** | `node-runner-poc/judge-tests/challenge-001/product.hidden.test.js` & `runner/challenge.js` | Server-side secure storage (`judge-tests/` or S3) + `AssignmentTestCase` (`visibility: "HIDDEN"`) | Organizer-only tests. Injected exclusively during Phase 2 into `__hidden__/`; never transmitted to student clients. |
| **5** | **Docker Execution** | `node-runner-poc/runner/docker.js` (`runDocker`) & `challenge-001/Dockerfile` | `apps/runner-orchestrator/src/node-runner.ts` & `apps/runner-orchestrator/Dockerfile.node` | Spawns hardened Docker container (`--network=none`, `--read-only`, tmpfs, cgroups limits, `--cap-drop=ALL`). |
| **6** | **Jest Execution** | Container command in `runner/docker.js` via `npm test` / `npm run test:all` | Controlled exclusively by server in `apps/runner-orchestrator/src/node-runner.ts` | Runs Jest with `--json --outputFile=/submission/jest-results.json`. Student cannot pass arbitrary CLI flags. |
| **7** | **Result Parsing** | `node-runner-poc/runner/jestParser.js` & `judge/createJudgeResult.js` | `apps/runner-orchestrator/src/node-result-mapper.ts` & `packages/api/src/lib/test-run-scoring.ts` | Reads `jest-results.json`, extracts per-test statuses, computes scores against `AssignmentTestCase`, and posts to `/api/test-runner/callback`. |
| **8** | **Cleanup** | `node-runner-poc/server.js` (`finally`) & `runner/runner.js` (`finally`) | `apps/runner-orchestrator/src/node-sandbox.ts` (`cleanupWorkspace`) & `node-runner.ts` | Ensures container kill on timeout and recursive workspace deletion on disk even after unexpected failures. |

---

### Detailed Breakdown of Responsibilities

#### Responsibility 1: Submission Handling
* **In POC:** `node-runner-poc/server.js` lines 50–225.
  - Receives JSON `{ challengeId: string, files: Record<string, string> }`.
  - Limits: Max 20 files, max 256 KB per file, max 1 MB total.
  - Prefix validation: Only permits `backend/`.
  - Blacklists: `challenge.json`, `package-lock.json`, `pnpm-lock.yaml`, `jest.config.js`, `__hidden__/`, `tests/`, `.git/`, `node_modules/`.
  - Traversal check: Rejects `..`, null bytes, and absolute paths.
  - Writes to a temp directory and passes to `runChallenge`.
* **In Tutly:**
  - `packages/api/src/routers/submission.ts`: Receives student submission, persists student files into S3/MinIO via `@tutly/storage`, checks `template-policy.ts` to ensure template tests cannot be deleted or overwritten, and creates a `SubmissionTestRun` row in `QUEUED` state.
  - `apps/web/src/app/api/test-runner/claim/route.ts`: Called by the runner orchestrator via authenticated HTTP to atomically claim the run and receive the student submission data and challenge configuration.

#### Responsibility 2: Workspace Creation
* **In POC:** `node-runner-poc/runner/runner.js` lines 40–180.
  - Allocates `os.tmpdir()/tutly-run-<uuid>`.
  - Copies student submission (skipping `node_modules`, `__hidden__`, `.git`).
  - Overlays trusted challenge visible tests from `challengePath/tests` to `workDir/tests`.
  - Overlays trusted `package.json` and `pnpm-lock.yaml` from `challengePath`.
* **In Tutly:**
  - Dedicated `apps/runner-orchestrator/src/node-sandbox.ts`.
  - Replaces Sandpack's virtual `manifest.json` with a real physical disk directory structure.
  - Uses hardened `safeJoin` to guard against symlinks and path traversal escapes.

#### Responsibility 3: Visible Tests
* **In POC:** `challenge-001/tests/product.visible.test.js` & `challenge-001/package.json`.
  - 4 Supertest test cases testing product creation, tags validation, and deletion.
  - Invoked via `npm test` -> `jest tests/product.visible.test.js`.
* **In Tutly:**
  - Part of the challenge assets served to the student's editor for local running/feedback.
  - Evaluated in Phase 1 of the Node runner.
  - Mapped to `AssignmentTestCase` rows where `visibility = 'VISIBLE'`.

#### Responsibility 4: Hidden / Judge-Only Tests
* **In POC:** `node-runner-poc/judge-tests/challenge-001/product.hidden.test.js`.
  - 4 additional test cases testing edge conditions (UUID uniqueness, 404 on missing, double delete, tag array types).
  - Stored strictly outside the challenge repository.
  - Injected into `workDir/__hidden__/` **only** during the hidden test phase.
* **In Tutly:**
  - Stored server-side in `apps/runner-orchestrator/judge-tests/<challengeId>/` (or fetched securely via S3).
  - NEVER sent to the client browser or exposed via public API endpoints.
  - Injected into `workDir/__hidden__/` only during Phase 2.
  - Mapped to `AssignmentTestCase` rows where `visibility = 'HIDDEN'`.

#### Responsibility 5: Docker Execution & Container Hardening
* **In POC:** `node-runner-poc/runner/docker.js`.
  - Executes `docker run`:
    - `--rm` (auto remove container)
    - `--network=none` (zero network egress/ingress)
    - `--memory=512m`
    - `--cpus=1`
    - `--pids-limit=128`
    - `--cap-drop=ALL` (drops all Linux capabilities)
    - `--security-opt=no-new-privileges`
    - `-v ${workDir}:/submission`
    - `-w /submission`
    - Image: `tutly/node-runner:22`
  - Timeout: 60 seconds via `spawnSync`.
* **In Tutly:**
  - `apps/runner-orchestrator/src/node-runner.ts`.
  - Employs asynchronous `spawn` with active process tracking and a timeout watchdog that triggers `docker kill <containerName>`.
  - Adds `--read-only` root filesystem and tmpfs `/tmp:rw,noexec,nosuid,size=128m`.

#### Responsibility 6: Jest Execution
* **In POC:** `node-runner-poc/runner/docker.js` lines 7–12.
  - Appends `-- --json --outputFile=/submission/jest-results.json` to the npm test command.
  - Phase 1 (Visible): `npm test -- --json --outputFile=/submission/jest-results.json`
  - Phase 2 (Hidden): `npm run test:all -- --json --outputFile=/submission/jest-results.json`
* **In Tutly:**
  - Controlled 100% by the server in `node-runner.ts`. The student provides code only, never CLI scripts.

#### Responsibility 7: Result Parsing & Normalization
* **In POC:** `node-runner-poc/runner/jestParser.js` and `judge/createJudgeResult.js`.
  - Reads `workDir/jest-results.json`.
  - Extracts `{ passed, failed, total }`.
  - Checks: `success = !timedOut && hidden.failed === 0 && hidden.total > 0`.
* **In Tutly:**
  - `apps/runner-orchestrator/src/node-result-mapper.ts` parses `jest-results.json` into detailed test results (`title`, `passed`, `durationMs`, `error`, `visibility`).
  - Calls Tutly's `POST /api/test-runner/callback` (`recordTestRunOutcome`).
  - Computes weighted points against `AssignmentTestCase`, updates `SubmissionTestRun`, and updates `SubmissionReview`.

#### Responsibility 8: Cleanup & Resource Lifecycle
* **In POC:** `try ... finally` blocks in `server.js` and `runner/runner.js` calling `fs.rmSync(workDir, { recursive: true, force: true })`.
* **In Tutly:**
  - `cleanupWorkspace(cwd)` inside `finally` block in `node-runner.ts` / `job.ts`.
  - `apps/runner-orchestrator/src/index.ts`: Boot-time reaper and periodic reaper cleaning up orphaned containers and resetting stale `RUNNING` rows to `ERROR`.

---

## 4. Architecture Comparison Matrix

| Architectural Dimension | Reference POC (`~/college/gdg/Questions`) | Current Tutly (`~/college/gdg/Tutly`) | Planned Tutly Node Runner V1 |
| :--- | :--- | :--- | :--- |
| **Primary Workload** | Node.js Backend & API challenges | In-browser frontend sandboxes (React, Vanilla) | Node.js Full-Stack (Backend + Frontend) |
| **Execution Engine** | Headless Node 22 Docker container | Headless Chromium + Playwright + Sandpack client | Dedicated Headless Node 22 Docker container |
| **Docker Base Image** | `tutly/node-runner:22` (pre-cached npm modules) | `ghcr.io/tutlylabs/tutly-browser-runner:latest` | `ghcr.io/tutlylabs/tutly-node-runner:22` |
| **Workspace Layout** | Standard disk tree: `backend/`, `tests/`, `package.json` | Virtual `manifest.json` with Sandpack-wrapped files | Standard disk tree: `backend/`, `frontend/`, `tests/` |
| **Submission Ingestion** | Simple HTTP POST `/api/judge` with in-memory files | Full tRPC `createSubmission` -> MinIO S3 -> Postgres | Same Tutly tRPC -> MinIO S3 -> Postgres |
| **Execution Queue** | Synchronous blocking single-job execution | In-memory asynchronous queue with concurrency limit (`env.CONCURRENCY = 2`) | Same in-memory queue with bounded concurrency & DB claim |
| **Hidden Test Delivery** | Local filesystem copy from `judge-tests/<id>` | In-memory string injected into Sandpack template | Stored server-side in `judge-tests/` or S3; injected to `__hidden__/` |
| **Result Callback** | Synchronous HTTP JSON response | Authenticated HTTP POST to `/api/test-runner/callback` | Same authenticated HTTP POST to `/api/test-runner/callback` |
| **Result Redaction** | Basic judge summary object returned to caller | Server-side role projection (`projectTestRunForViewer`) | Strict server-side projection: hidden tests never reach student |

---

## 5. Deep Dive: Reference POC Implementation

### Directory Layout & Role Breakdown

```
~/college/gdg/Questions/
├── challenge-001/
│   ├── backend/
│   │   ├── controllers/productController.js
│   │   ├── data/products.js
│   │   ├── routes/productRoutes.js
│   │   └── server.js
│   ├── frontend/
│   │   ├── app.js, index.html, style.css
│   ├── tests/
│   │   └── product.visible.test.js           <-- Visible test suite (4 tests)
│   ├── challenge.json                         <-- Test commands configuration
│   ├── Dockerfile                             <-- Node 22 runner base image
│   └── package.json                           <-- Dependencies & test scripts
├── node-runner-poc/
│   ├── judge-tests/
│   │   └── challenge-001/
│   │       └── product.hidden.test.js         <-- Hidden test suite (4 tests)
│   ├── runner/
│   │   ├── challenge.js                       <-- Config loader & directory copier
│   │   ├── docker.js                          <-- Hardened Docker spawn invocation
│   │   ├── jestParser.js                      <-- Result JSON extractor
│   │   ├── judge.js                           <-- Aggregator & success decider
│   │   └── runner.js                          <-- Core runChallenge orchestrator
│   ├── runner.js                              <-- CLI entry point for testing
│   └── server.js                              <-- HTTP API daemon on port 3000
└── submissions/
    └── test-user/                             <-- Verified student submission sample
```

### Two-Phase Execution Model

The POC operates in two sequential phases:

```
[ PHASE 1: VISIBLE TEST RUN ]
  1. Assemble workspace: student files + challenge package.json + tests/
  2. Spawn Docker with command: `npm test -- --json --outputFile=/submission/jest-results.json`
  3. Jest discovers: `tests/product.visible.test.js`
  4. Result: 4 passed / 4 total
  5. Clean up workspace

[ PHASE 2: HIDDEN TEST RUN ]
  1. Assemble workspace: student files + challenge package.json + tests/
  2. Inject: `judge-tests/challenge-001/*` -> `workDir/__hidden__/*`
  3. Spawn Docker with command: `npm run test:all -- --json --outputFile=/submission/jest-results.json`
  4. Jest discovers: `tests/product.visible.test.js` AND `__hidden__/product.hidden.test.js`
  5. Result: 8 passed / 8 total
  6. Clean up workspace
```

### Container Base Image Optimization (`tutly/node-runner:22`)

The POC's `Dockerfile` solves container startup latency:
```dockerfile
FROM node:22-alpine
WORKDIR /opt/tutly-runtime
COPY package*.json ./
RUN npm install --no-audit --no-fund
ENV NODE_PATH=/opt/tutly-runtime/node_modules
ENV PATH=/opt/tutly-runtime/node_modules/.bin:$PATH
```
* Pre-installs `express`, `jest`, `supertest` into `/opt/tutly-runtime/node_modules`.
* Sets `NODE_PATH` and `PATH` globally.
* When mounting `/submission`, the container **never executes `npm install`**. It immediately executes `jest` in **< 1.8 seconds total**.

### Empirical POC Test Run Verification

Executed live during inspection:
```
=== VISIBLE RUN ===
Challenge: challenge-001
Runtime: tutly/node-runner:22
Starting Docker container...
Docker process finished.
Cleaning workspace... Workspace removed.

=== HIDDEN RUN ===
Challenge: challenge-001
Runtime: tutly/node-runner:22
Starting Docker container...
Docker process finished.
Cleaning workspace... Workspace removed.

=== JUDGE RESULT ===
{
  "challengeId": "challenge-001",
  "visible": { "passed": 4, "failed": 0, "total": 4 },
  "hidden":  { "passed": 8, "failed": 0, "total": 8 },
  "durationMs": 3619,
  "timedOut": false,
  "success": true
}
```

---

## 6. Deep Dive: Existing Tutly Execution Architecture

### Existing Browser/Sandpack Runner

* **Files:**
  - `apps/runner-orchestrator/runtime/driver.mjs`
  - `apps/runner-orchestrator/runtime/index.html`
  - `apps/runner-orchestrator/Dockerfile.browser`
  - `apps/runner-orchestrator/src/jest-runner.ts`
  - `apps/runner-orchestrator/src/sandbox.ts`
* **Mechanism:** Mounts Sandpack files into a virtual browser runtime powered by Playwright and headless Chromium.
* **Preservation Mandate:** **Must remain untouched.** The Node runner will be implemented as a parallel execution branch.

### Database Entities Available for Reuse

Tutly's existing schema ([`packages/db/prisma/schema.prisma`](file:///Users/akashpaluvai/college/gdg/Tutly/packages/db/prisma/schema.prisma)) fully accommodates the Node runner without schema alterations:
1. `Attachment`:
   - `submissionMode`: Has enum value `WORKSPACE` or `SANDBOX`.
   - `hiddenTestFiles`: JSON field for server-side hidden tests.
   - `workspaceConfig`: 1-to-1 relation to `AssignmentConfig`.
2. `AssignmentConfig`:
   - `framework`: e.g. `"node"` / `"express"`.
   - `testCommand`: e.g. `"npm test"`.
3. `AssignmentTestCase`:
   - Stores individual test cases, points, and `visibility: "VISIBLE" | "HIDDEN"`.
4. `SubmissionTestRun`:
   - Tracks `status: "QUEUED" | "RUNNING" | "PASSED" | "FAILED" | "ERROR"`.
   - Records `visiblePassed`, `visibleTotal`, `hiddenPassed`, `hiddenTotal`, `score`, `maxScore`, `jestReport`.
5. `Point` & `SubmissionReview`:
   - Automatically updated upon test completion to record grades and trigger instructor review.

### Server-Side Test Visibility Redaction (`projectTestRunForViewer`)

In `packages/api/src/lib/test-visibility.ts`:
* When an instructor views a test run: Returns all results including hidden test cases and failures.
* When a student views a test run:
  - `jestReport` is set to `null`.
  - `hiddenPassed` and `hiddenTotal` are forced to `0`.
  - `outputSummary.results` strictly strips all items where `visibility === "HIDDEN"`.
  - Before the due date, only visible aggregates are returned.

### Queueing & 200-Participant Scalability Analysis

The current queue in `apps/runner-orchestrator/src/queue.ts`:
- Uses an in-memory queue: `pending: Job[]`, `active: Set<string>`.
- Default concurrency: `CONCURRENCY = 2` (configured in `env.ts`).
- At 200 submissions, each taking ~3.5 seconds:
  - Total serial runtime = 700 seconds (~11.6 minutes).
  - At `CONCURRENCY = 4` on a multi-core server: ~2.9 minutes total clearance time.
- **Safety Features Already Present:**
  - `enqueue` deduplicates if `active.has(id)` or already pending.
  - Startup recovery: On reboot, queries Postgres for recent `QUEUED` runs and re-enqueues up to 100 rows.
  - Stale run reaper: Periodically resets jobs in `RUNNING` for > 15 minutes to `ERROR`.
  - DB claim lock: `updateMany({ where: { id, status: "QUEUED" }, data: { status: "RUNNING" } })` guarantees mutual exclusion.

---

## 7. Gap Analysis

1. **Workspace Format:**  
   Existing `sandbox.ts` produces a Sandpack virtual `manifest.json`. A Node project requires a real directory tree on disk (`backend/`, `tests/`, `package.json`).
2. **Container Runtime:**  
   Existing `jest-runner.ts` spawns `ghcr.io/tutlylabs/tutly-browser-runner` running Playwright. The Node runner requires `ghcr.io/tutlylabs/tutly-node-runner:22` executing Jest CLI directly against the workspace.
3. **Execution Dispatcher Branch:**  
   In `apps/runner-orchestrator/src/job.ts`, the job processor currently defaults unconditionally to Sandpack + browser runner. It needs a routing switch:
   - If challenge is `WORKSPACE` / `node`: Route to `runNodeChallenge()`.
   - Else: Route to `runJest()` (existing browser runner).
4. **Result Format Translation:**  
   The browser runner produces Sandpack driver reports. The Node runner must parse native Jest JSON output (`jest-results.json`) and normalize it into Tutly's `CallbackBody` results.

---

## 8. Target Architecture & Proposed Node Runner V1 Design

```
                                  [ Tutly Submission ]
                                           │
                                           ▼
                              [ SubmissionTestRun: QUEUED ]
                                           │
                                           ▼
                             [ runner-orchestrator /enqueue ]
                                           │
                                           ▼
                                [ Claim: POST /claim ]
                                           │
                                           ▼
                     ┌───────────────────────────────────────────┐
                     │          job.ts Dispatch Router           │
                     └─────────────────────┬─────────────────────┘
                                           │
                    ┌──────────────────────┴──────────────────────┐
                    ▼                                             ▼
       [ Is Browser/Sandpack? ]                        [ Is Node Full-Stack? ]
                    │                                             │
                    ▼                                             ▼
          Existing Browser Runner                     NEW: node-runner.ts
     • sandbox.ts                                  • node-sandbox.ts (real disk files)
     • jest-runner.ts                              • Hardened Docker (tutly-node-runner:22)
     • Chromium / Playwright                       • Phase 1: Visible (npm test)
     • results.json                                • Phase 2: Hidden (npm run test:all)
     (UNTOUCHED)                                   • node-result-mapper.ts
                    │                                             │
                    └──────────────────────┬──────────────────────┘
                                           │
                                           ▼
                       [ POST /api/test-runner/callback ]
                                           │
                                           ▼
                     [ Postgres: TestRun, Points, Review ]
                                           │
                                           ▼
                       [ Student View (Redacted) / Admin ]
```

### Proposed Directory Layout for Node Runner in Tutly

```
apps/runner-orchestrator/
├── Dockerfile                      <-- Orchestrator service
├── Dockerfile.browser              <-- Existing browser runner (UNTOUCHED)
├── Dockerfile.node                 <-- NEW: Node 22 runner base image
├── runtime/                        <-- Existing browser runtime (UNTOUCHED)
├── judge-tests/                    <-- Server-side hidden tests storage
│   └── challenge-001/
│       └── product.hidden.test.js
└── src/
    ├── index.ts                    <-- HTTP server & queue endpoints
    ├── queue.ts                    <-- In-memory queue (UNTOUCHED)
    ├── job.ts                      <-- Add dispatch branch (Node vs Browser)
    ├── sandbox.ts                  <-- Existing browser sandbox (UNTOUCHED)
    ├── jest-runner.ts              <-- Existing browser runner (UNTOUCHED)
    ├── result-mapper.ts            <-- Existing browser mapper (UNTOUCHED)
    ├── node-sandbox.ts             <-- NEW: Node filesystem workspace assembler
    ├── node-runner.ts              <-- NEW: Hardened Docker runner (visible + hidden)
    └── node-result-mapper.ts       <-- NEW: Jest JSON -> Tutly MappedReport parser
```

---

## 9. Phased Implementation Roadmap

* **Phase 1 (Complete):** Architecture inspection & comparison (`inspection4.md`). Zero code modified.
* **Phase 2:** Implement standalone Node runner modules inside `apps/runner-orchestrator/src/` (`node-sandbox.ts`, `node-runner.ts`, `node-result-mapper.ts`).
* **Phase 3:** Define and build `Dockerfile.node` (`tutly-node-runner:22`).
* **Phase 4:** Create a local test suite in Tutly validating:
  1. Visible tests pass (4/4)
  2. Hidden tests pass (8/8)
  3. Failure detection on invalid code
  4. Path traversal / escaping rejection
  5. Container timeout & memory limits
  6. Workspace & container cleanup
* **Phase 5:** Wire into `job.ts` and verify end-to-end integration with `SubmissionTestRun`, `/api/test-runner/claim`, and `/api/test-runner/callback`.
* **Phase 6:** End-to-end verification via Tutly web client / tRPC.
* **Phase 7:** Concurrency benchmarks for 200 participants.
