# Tutly Capability & Architecture Audit

> **Audit Date:** September 10, 2026  
> **Target System:** Tutly Monorepo (`apps/web`, `apps/playgrounds`, `apps/runner-orchestrator`, `packages/api`, `packages/db`, `packages/storage`, `packages/fsrelay`)  
> **Focus Areas:** In-browser IDEs, Sandpack runtime capabilities, Runner Orchestrator execution flow, TestRuns router & data storage, Submission persistence, Prisma schema reuse, Hidden test mechanisms, and Assignment/Challenge model repurposing.

---

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [Audit Area 1: `/playgrounds` — How the IDE Works](#1-playgrounds--how-the-ide-works)
3. [Audit Area 2: Sandpack — What Can Execute in the Browser?](#2-sandpack--what-can-execute-in-the-browser)
4. [Audit Area 3: `/runner-orchestrator` — What Exactly Happens on Submission?](#3-runner-orchestrator--what-exactly-happens-on-submission)
5. [Audit Area 4: `testRuns` Router — How Tests & Results Are Stored](#4-testruns-router--how-tests--results-are-stored)
6. [Audit Area 5: Submission System — What Code Is Persisted?](#5-submission-system--what-code-is-persisted)
7. [Audit Area 6: Prisma Schema — Which Tables We Can Reuse](#6-prisma-schema--which-tables-we-can-reuse)
8. [Audit Area 7: Hidden & Read-Only Files — Usability for Hidden Tests](#7-hidden--read-only-files--usability-for-hidden-tests)
9. [Audit Area 8: Challenge & Assignment Model — What We Can Repurpose](#8-challenge--assignment-model--what-we-can-repurpose)
10. [Key Architectural Findings & Recommendations](#key-architectural-findings--recommendations)

---

## Executive Summary

Tutly possesses a **mature, dual-execution architecture**:
1. **In-Browser Sandpack + Monaco IDE:** A complete client-side Web IDE supporting 10+ frontend frameworks and in-browser Jest testing, self-hosted offline bundler assets, split editors, file trees, and granular file visibility controls.
2. **Local / Containerized VS Code Web IDE:** A full VS Code Web instance connecting over WebSocket and HTTP (`fsrelay`) to the student's local machine or container daemon via the Tutly CLI (`apps/cli` at port 4242).
3. **Isolated Docker Runner Orchestrator:** An automated grading engine that spins up sandboxed Playwright/Chromium Docker containers with tight cgroup limits, builds student submissions with teacher templates and hidden tests, runs test suites, and securely maps test results.
4. **Multi-Tenant Object Storage & RBAC:** Submissions and templates are stored cleanly in S3/MinIO via Flydrive, with strict server-side policy enforcement (`template-policy.ts`) that guarantees students cannot view, submit, or tamper with hidden tests or solution files.

---

## 1. `/playgrounds` — How the IDE Works

Tutly implements **two distinct IDE environments**, serving different execution models:

```
                                  ┌───────────────────────────────┐
                                  │      Tutly IDE Architecture   │
                                  └───────────────┬───────────────┘
                                                  │
                 ┌────────────────────────────────┴────────────────────────────────┐
                 ▼                                                                 ▼
┌─────────────────────────────────────────┐                     ┌─────────────────────────────────────────┐
│     In-Browser Sandpack + Monaco        │                     │             VS Code Web Mode            │
│  apps/web/src/app/(protected)/...       │                     │       apps/playgrounds + @tutly/fsrelay │
├─────────────────────────────────────────┤                     ├─────────────────────────────────────────┤
│ • Zero installation required            │                     │ • Full VS Code Web (vscode-web)         │
│ • Runs client-side via Sandpack bundler │                     │ • Connects to student machine via CLI   │
│ • Monaco code editor + custom tabs      │                     │ • Daemon at http://localhost:4242       │
│ • SandpackTests in bottom panel         │                     │ • Real PTY terminal + filesystem relay  │
│ • Instant preview iframe                │                     │ • Supports arbitrary compilers & CLI    │
└─────────────────────────────────────────┘                     └─────────────────────────────────────────┘
```

### Architecture A: In-Browser Sandpack + Monaco IDE
* **Core Entrypoint:** [Playground.tsx](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/src/app/(protected)/playgrounds/_components/Playground.tsx), [SandboxWrapper.tsx](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/src/app/(protected)/playgrounds/sandbox/_components/SandboxWrapper.tsx), and [IDEShell.tsx](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/src/app/(protected)/playgrounds/_components/ide/IDEShell.tsx).
* **State Management:** [ideStore.tsx](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/src/app/(protected)/playgrounds/_components/ide/ideStore.tsx) manages an in-memory tree layout supporting split panes (left/right/top/bottom), tab management, active files, and sidebar toggling.
* **Code Editing:** [EditorPane.tsx](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/src/app/(protected)/playgrounds/_components/ide/EditorPane.tsx) embeds `@monaco-editor/react`. When a user edits a file, updates are pushed directly to the Sandpack files map via `sandpack.updateFile(path, code)`.
* **File Tree & Metadata:** [FileTree.tsx](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/src/app/(protected)/playgrounds/_components/ide/FileTree.tsx) and [FileFlagsBar.tsx](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/src/app/(protected)/playgrounds/sandbox/_components/FileFlagsBar.tsx) render file nodes, supporting read-only files, hidden files, active entrypoints, and file deletion/creation.
* **Preview & Execution:** [PreviewPane.tsx](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/src/app/(protected)/playgrounds/_components/ide/PreviewPane.tsx) loads an iframe powered by `@codesandbox/sandpack-react`. It utilizes a self-hosted Sandpack bundler URL configured via [use-bundler-url.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/src/hooks/use-bundler-url.ts).
* **Bottom Panel & In-Browser Tests:** [BottomPanel.tsx](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/src/app/(protected)/playgrounds/_components/ide/BottomPanel.tsx) renders tabs for `Console` (via `useSandpackConsole`) and `Tests` (via `SandpackTests`). If the project has files matching `\.(test|spec)\.[tj]sx?$`, the user can execute tests directly in their browser before submitting.

### Architecture B: Local / VS Code Web Mode
* **Server App:** [apps/playgrounds/http.js](file:///Users/akashpaluvai/college/gdg/Tutly/apps/playgrounds/http.js) serves a built `vscode-web` instance on port 8080.
* **Extension Layer:** [packages/fsrelay/src/extension.ts](file:///Users/akashpaluvai/college/gdg/Tutly/packages/fsrelay/src/extension.ts) registers a custom file system provider (`tutlyfs:/`) and pseudo-terminal profile (`tutly.terminal-profile`).
* **Connection Handshake:** [local-playground-screen.tsx](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/src/app/(protected)/vscode/local-playground-screen.tsx) polls `http://localhost:4242/api/health` with `x-api-key: tutly-dev-key`. Once the local `tutly` CLI daemon is detected, the web app unlocks the VS Code iframe.
* **Execution & Terminal:** The student works in full VS Code Web; terminal commands run on the student's actual host machine (or remote VM), and commands like `tutly submit` and `tutly save` sync files back to the Tutly server.

---

## 2. Sandpack — What Can Execute in Browser?

Sandpack is CodeSandbox's in-browser bundler that compiles and runs code inside an isolated web worker and iframe environment using WebAssembly, service workers, and Babel transforms.

### What Can Execute in Browser:
Defined in [templetes/index.tsx](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/src/app/(protected)/playgrounds/sandbox/_components/templetes/index.tsx):

| Template ID | Technology / Framework | Browser Execution Engine |
| :--- | :--- | :--- |
| `static` | HTML5, CSS3, Vanilla JavaScript | Native browser iframe document parsing |
| `vanilla`, `vanilla-ts` | TypeScript / ESNext | Sandpack client-side Babel transpile |
| `react`, `react-ts` | React 18 / 19 + JSX / TSX | React DOM client bundler |
| `vue`, `vue-ts` | Vue 3 SFC (`.vue`) | Vue single-file compiler in-browser |
| `angular` | Angular components | Sandpack Angular runtime |
| `svelte` | Svelte 3/4/5 components | Svelte in-browser compiler |
| `solid` | Solid.js JSX | Solid compiler |
| `test-ts` | TypeScript + Jest test suite | **Jest in-browser runner** (`mode: "tests"`, `environment: "parcel"`) |

### In-Browser Unit Testing:
In [runtime/tests-ts.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/src/app/(protected)/playgrounds/sandbox/_components/templetes/runtime/tests-ts.ts), Tutly configures:
```typescript
export const TEST_TYPESCRIPT_TEMPLATE = {
  files: {
    "/add.ts": { code: `export const add = (a: number, b: number): number => a + b;` },
    "/add.test.ts": {
      code: `import { add } from './add';\ndescribe('add', () => {\n  test('Commutative Law', () => {\n    expect(add(1, 2)).toBe(add(2, 1));\n  });\n});`
    }
  },
  main: "/add.test.ts",
  environment: "parcel",
  mode: "tests"
};
```
This enables browser-side execution of `describe()`, `test()`, and `expect()` assertions without hitting any backend server.

### What CANNOT Execute in Browser Sandpack:
* **Server-side processes & native backends:** Node.js HTTP servers (e.g. `app.listen(3000)`), Express backends, Python scripts, Go binaries, C++, Rust, and SQL databases cannot run natively inside client-side Sandpack.
* **Legacy Node Templates Aliased:** Note that [templetes/index.tsx](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/src/app/(protected)/playgrounds/sandbox/_components/templetes/index.tsx#L37-L50) intentionally aliases Node-env templates to browser runtimes:
  - `node` → `VANILLA_TEMPLATE`
  - `nextjs` → `REACT_TEMPLATE`
  - `astro` → `STATIC_TEMPLATE`
  - `vite-*` → Standard component templates
* **Self-Hosted / Offline Bundler Asset Support:** To prevent relying on CodeSandbox external CDNs, Tutly provides [copy-sandpack-assets.js](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/scripts/copy-sandpack-assets.js), copying the offline Sandpack bundler to `apps/web/public/sandpack/` so the bundler runs locally and self-contained.

---

## 3. `/runner-orchestrator` — What Exactly Happens on Submission?

The runner orchestrator is an isolated microservice located in [apps/runner-orchestrator](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator). It is completely responsible for grading student submissions against visible and hidden test suites.

```
┌──────────────┐     1. submit mutation       ┌──────────────┐
│  Student /   ├─────────────────────────────►│   Web App    │
│  Instructor  │                              │ (packages/   │
└──────────────┘                              │     api)     │
                                              └──────┬───────┘
                                                     │ 2. Create SubmissionTestRun (QUEUED)
                                                     │ 3. POST /enqueue { testRunId }
                                                     ▼
                                              ┌──────────────┐
                                              │   Runner     │
                                              │ Orchestrator │
                                              └──────┬───────┘
                                                     │ 4. POST /api/test-runner/claim
                                                     │    (Retrieves student data, template, hidden tests)
                                                     ▼
                                              ┌──────────────┐
                                              │ Assemble     │
                                              │ Workspace    │
                                              │ (sandbox.ts) │
                                              └──────┬───────┘
                                                     │ 5. Write template + overlay submission
                                                     │    + anti-tamper visible tests
                                                     │    + mount /__hidden__/ tests
                                                     ▼
                                              ┌──────────────┐
                                              │ Docker Run   │
                                              │ (Playwright/ │
                                              │  Chromium)   │
                                              └──────┬───────┘
                                                     │ 6. Headless browser loads Sandpack client
                                                     │ 7. Executes all test suites to completion
                                                     │ 8. Dumps /work/results.json
                                                     ▼
                                              ┌──────────────┐
                                              │ Result       │
                                              │ Mapper &     │
                                              │ Callback     │
                                              └──────┬───────┘
                                                     │ 9. POST /api/test-runner/callback
                                                     │    (Scores run, updates DB, marks PASSED/FAILED)
                                                     ▼
                                              ┌──────────────┐
                                              │  Postgres DB │
                                              └──────────────┘
```

### End-to-End Step-by-Step Breakdown:

#### 1. Enqueue & Queue Worker
* When a submission is created in [submission.ts](file:///Users/akashpaluvai/college/gdg/Tutly/packages/api/src/routers/submission.ts#L274-L302), a `submissionTestRun` row is created with `status: "QUEUED"`.
* The server calls `enqueueTestRun(run.id)` via [runner-client.ts](file:///Users/akashpaluvai/college/gdg/Tutly/packages/api/src/lib/runner-client.ts), issuing `POST http://runner-orchestrator:8080/enqueue` with header `x-worker-secret`.
* In [queue.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/queue.ts), the job is added to an in-memory queue. A concurrency loop runs jobs up to `env.CONCURRENCY` (default: 2).

#### 2. Atomic Claim & Payload Retrieval
* [job.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/job.ts#L11) calls `claimRun(testRunId)`.
* In [claim/route.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/web/src/app/api/test-runner/claim/route.ts), the database row is atomically transitioned from `QUEUED` to `RUNNING`.
* The claim endpoint retrieves:
  - `submission.data`: Student's submitted source files from storage.
  - `assignment.sandboxTemplate`: The instructor's template.
  - `assignment.hiddenTestFiles`: The instructor's private test files.

#### 3. Workspace Assembly & Anti-Tamper Protection
In [sandbox.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/sandbox.ts#L66-L147), an ephemeral directory is created at `/work/run-<testRunId>-<timestamp>`:
1. **Template Base:** Teacher template files are extracted.
2. **Student Overlay:** Student files are overlaid onto the template.
3. **Anti-Tamper Visible Tests:** The visible test files from the original template are **re-applied on top of the student's submission**. If a student modified `add.test.ts` to `expect(true).toBe(true)`, their edit is discarded and the authentic test is restored!
4. **Hidden Tests Injected:** Hidden test files are written under the `/__hidden__/` directory.
5. **Manifest Generated:** A `manifest.json` is generated for the Sandpack browser runtime.

#### 4. Hardened Docker Container Execution
In [jest-runner.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/jest-runner.ts#L16-L35), Docker launches the image `mcr.microsoft.com/playwright:v1.60.0-noble` with strict sandbox flags:
```bash
docker run --rm --name tutly-browser-<runId> \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=128m \
  --memory=768m --memory-swap=768m \
  --cpus=1.0 \
  --pids-limit=128 \
  --security-opt=no-new-privileges \
  --cap-drop=ALL \
  -v /host/path:/work:rw \
  mcr.microsoft.com/playwright:v1.60.0-noble
```

#### 5. Headless Chromium Test Execution
* Container entrypoint executes [driver.mjs](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/runtime/driver.mjs):
  - Starts an internal Express server on port 8000 serving the offline Sandpack client bundle and `/manifest.json`.
  - Spawns headless Chromium via Playwright.
  - Navigates to `http://127.0.0.1:8000/index.html`.
* Inside [index.html](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/runtime/index.html):
  - Loads `@codesandbox/sandpack-client` in an iframe.
  - Subscribes to Sandpack test events (`initialize_tests`, `test_end`, `total_test_end`, `file_error`).
  - Dispatches `client.dispatch({ type: "run-all-tests" })`.
  - Collects all assertions, compile errors, and timing metrics into `window.__results`.
* `driver.mjs` writes the outcome to `/work/results.json` and cleanly exits.

#### 6. Result Mapping & Callback
* [result-mapper.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/result-mapper.ts) inspects `results.json`. Any test path starting with `__hidden__` is assigned `visibility: "HIDDEN"`.
* [callback.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/callback.ts) sends `POST /api/test-runner/callback` with status, normalized test results, and raw Jest reports.
* Finally, [job.ts](file:///Users/akashpaluvai/college/gdg/Tutly/apps/runner-orchestrator/src/job.ts#L86) executes `cleanupWorkspace(cwd)` to wipe the temporary directory.

---

## 4. `testRuns` Router — How Tests/Results Are Stored

The TRPC router is in [packages/api/src/routers/testRuns.ts](file:///Users/akashpaluvai/college/gdg/Tutly/packages/api/src/routers/testRuns.ts) with scoring and visibility logic in [test-run-scoring.ts](file:///Users/akashpaluvai/college/gdg/Tutly/packages/api/src/lib/test-run-scoring.ts) and [test-visibility.ts](file:///Users/akashpaluvai/college/gdg/Tutly/packages/api/src/lib/test-visibility.ts).

### Router Procedures:
1. `runVisible`: Handles student-triggered visible test executions (from browser/agent). Rejects any payload claiming to have evaluated `HIDDEN` tests (`"Hidden test results must be recorded by a trusted runner"`).
2. `enqueueOfficial`: Instructor-only procedure to re-run the official containerized test suite for a specific submission.
3. `rerunAllForAssignment`: Instructor-only procedure to re-queue all submissions for an assignment in bulk (rate-limited to once every 5 minutes).
4. `getForSubmission`: Retrieves test runs for a submission, protected by viewer projection.

### Database Persistence Model:

#### 1. `SubmissionTestRun` Table
Stores each individual test execution record:
* `id`: UUID
* `submissionId`, `assignmentId`
* `status`: `QUEUED` | `RUNNING` | `PASSED` | `FAILED` | `ERROR`
* `provider`: `LOCAL` | `SSH`
* `trigger`: e.g. `auto-submit`, `student-visible`, `instructor-rerun`, `rerun-all`
* `visiblePassed`, `visibleTotal`: Counts of visible tests
* `hiddenPassed`, `hiddenTotal`: Counts of private hidden tests
* `score`, `maxScore`: Numerical score awarded
* `outputSummary`: JSON containing `{ results: ReportedTest[], source: "runner-orchestrator" }`
* `jestReport`: Full JSON dump of the runner report
* `errorMessage`: Text error if timeout, OOM, or spawn failed
* `startedAt`, `completedAt`: Execution timestamps

#### 2. `Point` Table (Category: `TESTS`)
When tests complete, [test-run-scoring.ts](file:///Users/akashpaluvai/college/gdg/Tutly/packages/api/src/lib/test-run-scoring.ts#L195-L225) upserts a `Point` record:
* `submissionId`: Link to submission
* `category`: `TESTS`
* `score`: Calculated score
* `maxScore`: Maximum possible test score
* `testRunId`: Foreign key to `SubmissionTestRun`
* `feedback`: e.g. `"All tests passed"` or `"Visible tests need attention"`

#### 3. `SubmissionReview` Table
Automatically updated upon test completion:
* `status`: `AUTO_SCORED` (if no hidden tests remain or all passed) or `NEEDS_REVIEW` (if hidden tests failed or require human mentor inspection)
* `autoScore`: Scaled score
* `testRunId`: Foreign key to the winning run

### Privacy Projection (`projectTestRunForViewer`):
Students are strictly prevented from reverse-engineering test cases:
* **Instructors / Mentors:** Receive the complete payload (`jestReport`, `hiddenPassed`, `hiddenTotal`, all failure logs).
* **Students:**
  - `jestReport` is always stripped (`null`).
  - `hiddenPassed` and `hiddenTotal` are zeroed out (`0`).
  - **Before Deadline:** Students receive only aggregate totals (`aggregateOnly: { visiblePassed, visibleTotal }`) without individual failure messages.
  - **After Deadline:** Students can see individual visible test failure messages, but hidden test details remain hidden forever.

---

## 5. Submission System — What Code Is Persisted?

### Storage Location & Backend
* Files are stored in **S3 / MinIO** using the Flydrive abstraction layer ([packages/storage/src/disk.ts](file:///Users/akashpaluvai/college/gdg/Tutly/packages/storage/src/disk.ts)).
* **Object Key Path Convention:**
  ```
  org/{orgId}/courses/{courseId}/assignments/{assignmentId}/submissions/{submissionId}/{sanitizedFilePath}
  ```

### What Code Is Persisted:
In [packages/api/src/routers/submission.ts](file:///Users/akashpaluvai/college/gdg/Tutly/packages/api/src/routers/submission.ts#L233-L250), incoming files are filtered using `filterSubmissionInput(submittedRaw, template)`:

```typescript
// From template-policy.ts:
export function isTemplateOnly(path: string, file: SandpackFile | undefined): boolean {
  return isHiddenFromStudent(path, file) || isTestPath(path);
}
```

1. **Student Source Code:** Only the user's actual application files (e.g. `/App.tsx`, `/index.html`, `/src/utils.js`) are written to S3.
2. **Hidden Files:** Stripped. Any path matching `/__hidden__/`, `/solution/`, `.solution.`, or with `hidden: true` is dropped.
3. **Test Files:** Stripped. Any file matching `\.(test|spec)\.[tj]sx?$` is classified as **template-only** and dropped from the student's submission directory.
4. **Deleted Template Prevention:** If a student tries to delete a non-hidden template file, the API rejects the submission with `BAD_REQUEST` (`Cannot delete template files`).

### What Is Stored in Postgres:
* In the Postgres `submission` table, the `data` column is **kept null or legacy**; actual code lives entirely in object storage (`writeSubmission`).
* Postgres holds the relational metadata: `id`, `attachmentId`, `enrolledUserId`, `status` (`SUBMITTED`), `submissionDate`, and `overallFeedback`.

---

## 6. Prisma Schema — Which Tables We Can Reuse

The database schema in [schema.prisma](file:///Users/akashpaluvai/college/gdg/Tutly/packages/db/prisma/schema.prisma) has a rich set of pre-built tables that can be repurposed directly:

### Primary Candidate Tables for Reuse:

| Model Name | Line in Schema | Current Role in Tutly | Can We Reuse It? | Suggested Repurposing / Adaptations |
| :--- | :--- | :--- | :--- | :--- |
| **`Attachment`** | L677 | Represents an assignment or resource linked to a course/class | **YES (Primary)** | Acts as the **Challenge / Problem definition**. Has `title`, markdown `details`, `detailsJson`, `sandboxTemplate`, `hiddenTestFiles`, `submissionMode`, `dueDate`, `maxSubmissions`. |
| **`AssignmentConfig`** | L816 | Workspace execution configuration | **YES** | Stores execution instructions: `framework`, `setupCommand`, `devCommand`, `testCommand`, `previewPorts`, `readonlyPaths`, `grading` JSON. |
| **`AssignmentTestCase`** | L892 | Granular rubric test cases | **YES** | Stores individual challenge test cases: `title`, `visibility` (`VISIBLE` / `HIDDEN`), `command`, `points`, `timeoutMs`, and `metadata`. |
| **`submission`** | L707 | Student assignment submission | **YES** | Stores user submissions for challenges: `id`, `enrolledUserId`, `attachmentId`, `status`, `submissionDate`. |
| **`SubmissionTestRun`** | L914 | Test run execution audit | **YES** | Tracks every test execution run: `status`, `visiblePassed/Total`, `hiddenPassed/Total`, `score`, `maxScore`, `outputSummary`, `jestReport`, `errorMessage`. |
| **`SubmissionReview`** | L989 | Grading reviews & auto-scores | **YES** | Manages auto-graded results: `status` (`AUTO_SCORED`), `autoScore`, `manualScore`, `feedback`. |
| **`Point`** | L744 | Category-based points | **YES** | Manages test scores and leaderboards (`category: TESTS`). |
| **`AssignmentArtifact`** | L835 | File artifacts in S3 | **YES** | Stores starter zips, solution zips, submission archives, and test execution logs (`kind: STARTER / SUBMISSION / REPORT`). |
| **`ServiceConnection`** | L869 | SSH / Remote runners | **YES** | Can be reused if challenges execute against remote cluster runners. |
| **`PortSession`** | L958 | Web preview proxy | **YES** | For live web preview of interactive student applications. |

---

## 7. Hidden / Read-Only Files — Usability for Hidden Tests

### Direct Answer: **YES, 100% directly usable out-of-the-box.**
The codebase was intentionally architected for this exact workflow. Tutly has an end-to-end multi-layer isolation pipeline for hidden tests:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Hidden Test Pipeline                            │
└────────────────────────────────────────────────────────────────────────┘

1. INSTRUCTOR AUTHORING:
   • Place files in `/__hidden__/` OR name them `*.solution.*`
   • Or toggle "Hidden" switch in FileFlagsBar.tsx (sets `fileMeta.hidden: true`)
   • Stored in `template/tutly.json` in object storage

2. STUDENT VIEW (API Filter):
   • filterTemplateForStudent() in template-policy.ts removes all hidden files
   • Student never receives hidden files in tree, editor tabs, or API payloads

3. STUDENT SUBMISSION (Tamper Defense):
   • filterSubmissionInput() strips test and hidden paths from submission writes
   • Anti-tamper logic restores teacher's visible test files upon execution

4. RUNNER ORCHESTRATION:
   • assembleWorkspace() in sandbox.ts mounts hidden tests into `/__hidden__/`
   • result-mapper.ts detects `__hidden__` prefix and marks `visibility: "HIDDEN"`

5. REPORTING & PRIVACY:
   • projectTestRunForViewer() in test-visibility.ts conceals hidden test counts,
     names, and errors from students, while instructors see full diagnostics
```

### Path & Flag Conventions Already Enforced:
1. **Path-based hiding:**
   - Any path matching `/^__hidden__(\/|$)/i` (e.g. `/__hidden__/private.test.ts`) is automatically hidden.
   - Any path matching `/^solution(\/|\.|$)/i` or `\.solution\.` is automatically hidden.
2. **Metadata-based hiding:**
   - Setting `{ "hidden": true }` in `tutly.json` sidecar.
3. **Read-only enforcement:**
   - Setting `{ "readOnly": true }` in `tutly.json` renders the file in Monaco with edits blocked (`readOnly: true`), while allowing students to read it.

---

## 8. Challenge / Assignment Model — What We Can Repurpose

### Current Reality:
* There is **no separate `Challenge` table** in Tutly.
* The entire system runs on `Attachment` with `attachmentType: "ASSIGNMENT"`.
* Every assignment is attached to an academic hierarchy: `Course` → `Class` → `Attachment`.

### How to Repurpose `Attachment` into a Standalone Challenge Model:

```
                    ┌──────────────────────────────────────────────┐
                    │               Model Repurposing              │
                    └──────────────────────────────────────────────┘

  Current Assignment Schema                       Repurposed Challenge System
┌───────────────────────────────┐               ┌───────────────────────────────┐
│ Attachment                    │               │ Challenge (or Attachment)     │
├───────────────────────────────┤               ├───────────────────────────────┤
│ • title                       │ ────────────► │ • title                       │
│ • details / detailsJson       │ ────────────► │ • Problem statement / Readme  │
│ • submissionMode: SANDBOX     │ ────────────► │ • In-browser coding challenge │
│ • submissionMode: WORKSPACE   │ ────────────► │ • Backend / CLI challenge     │
│ • sandboxTemplate             │ ────────────► │ • Starter code & environment  │
│ • hiddenTestFiles             │ ────────────► │ • Hidden evaluation test suite│
│ • classId (Nullable!)         │ ────────────► │ • null (Stand-alone challenge)│
│ • courseId (Nullable!)        │ ────────────► │ • null or track/module ID     │
│ • testCases                   │ ────────────► │ • Public & Hidden test cases  │
│ • testRuns                    │ ────────────► │ • Submission execution runs   │
│ • maxSubmissions              │ ────────────► │ • Rate limits / retry limits  │
└───────────────────────────────┘               └───────────────────────────────┘
```

### Key Reuse Enablers:
1. **`classId` and `courseId` are already optional (`String?`):**
   You do **not** need to force challenges into a course or class. An `Attachment` can exist independently as a standalone coding challenge.
2. **`submissionMode` handles both paradigms:**
   - `SANDBOX`: Frontend / in-browser JS/TS/React/Vue challenges evaluated with Sandpack + Playwright.
   - `WORKSPACE`: Multi-file backend / containerized / CLI challenges evaluated with `AssignmentConfig`.
3. **`AssignmentTestCase` models LeetCode-style test cases:**
   - `visibility: "VISIBLE"` for example test cases shown in the problem description.
   - `visibility: "HIDDEN"` for hidden submission test cases used for final ranking/grading.
   - `points` for fractional weighted scoring.
4. **Multi-Attempt History:**
   - `SubmissionTestRun` already tracks `attempt: Int` so students can submit multiple times and track pass rates over time.

---

## Key Architectural Findings & Recommendations

1. **Do not re-invent hidden tests:** The existing `/__hidden__/` path pattern and `template-policy.ts` filtering system are already rock-solid and enforced at API, Storage, and Docker runner layers.
2. **Do not re-invent test execution for JS/TS/React:** The `runner-orchestrator` with Docker + Playwright + Sandpack is a working, production-grade browser execution harness.
3. **For Algorithmic / LeetCode style challenges:** You can either use the `Attachment` model directly with `submissionMode: "SANDBOX"` (using `test-ts` template), or add a thin `Challenge` model that wraps or mirrors `Attachment` with standalone tags, difficulty levels (`EASY`, `MEDIUM`, `HARD`), and language runtimes.
4. **For Non-JS Languages (Python, C++, Java):** Sandpack only handles browser JavaScript/TypeScript. For Python or other languages, the `submissionMode: "WORKSPACE"` pathway with `AssignmentConfig` and a backend container runner should be utilized instead of Sandpack.
