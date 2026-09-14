import { claimRun, postResults, type RunFetchResult } from "./callback.js";
import { runJest } from "./jest-runner.js";
import { logger } from "./logger.js";
import { assembleWorkspace, cleanupWorkspace } from "./sandbox.js";
import { runNodeChallenge } from "./node-runner.js";
import type { NodeSubmissionFile } from "./node-sandbox.js";
import path from "node:path";
import { existsSync } from "node:fs";

export function isNodeChallenge(run: NonNullable<RunFetchResult["run"]>): boolean {
  if (run.assignment.submissionMode === "WORKSPACE") return true;
  if (run.assignment.workspaceConfig?.framework === "node") return true;
  if (run.assignment.sandboxTemplate) {
    try {
      const decoded = Buffer.from(run.assignment.sandboxTemplate, "base64").toString("utf-8");
      if (decoded.includes('"language":"node"') || decoded.includes('"framework":"node"')) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  if (run.submission.data && typeof run.submission.data === "object") {
    const keys = Object.keys(run.submission.data);
    if (keys.some((k) => k.startsWith("backend/") || k.startsWith("/backend/"))) {
      return true;
    }
  }
  return false;
}

export async function processJob(testRunId: string): Promise<void> {
  const log = logger.child({ testRunId });
  let cwd: string | undefined;

  try {
    const claim = await claimRun(testRunId);
    if (!claim.claimed || !claim.run) {
      log.info("claim skipped (run not in QUEUED state)");
      return;
    }
    const { run } = claim;

    // ==========================================
    // DISPATCH: NODE EVENT RUNNER
    // ==========================================
    if (isNodeChallenge(run)) {
      const rawFiles = (run.submission.data ?? {}) as Record<string, NodeSubmissionFile>;
      const submissionFiles: Record<string, NodeSubmissionFile> = {};
      for (const [k, v] of Object.entries(rawFiles)) {
        const cleanPath = k.startsWith("/") ? k.slice(1) : k;
        const baseName = path.basename(cleanPath);
        if (
          baseName === "package.json" ||
          baseName === "package-lock.json" ||
          baseName === "pnpm-lock.yaml" ||
          baseName === "yarn.lock" ||
          baseName === "jest.config.js" ||
          baseName === "challenge.json" ||
          baseName === "tutly.json" ||
          cleanPath.startsWith("tests/") ||
          cleanPath.startsWith("__hidden__/") ||
          cleanPath.startsWith("node_modules/") ||
          cleanPath.startsWith(".git/")
        ) {
          continue;
        }
        submissionFiles[cleanPath] = v;
      }

      // Resolve challenge directory (fixture or configured path)
      const candidatesChallenge = [
        path.resolve(process.cwd(), "fixtures/challenge-001"),
        path.resolve(import.meta.dirname, "../fixtures/challenge-001"),
        path.resolve("/Users/akashpaluvai/college/gdg/Questions/challenge-001"),
      ];
      const challengeDir = candidatesChallenge.find((d) => existsSync(d));

      // Resolve hidden tests directory
      const candidatesJudge = [
        path.resolve(process.cwd(), "fixtures/judge-tests/challenge-001"),
        path.resolve(import.meta.dirname, "../fixtures/judge-tests/challenge-001"),
        path.resolve("/Users/akashpaluvai/college/gdg/Questions/node-runner-poc/judge-tests/challenge-001"),
      ];
      const judgeTestsDir = candidatesJudge.find((d) => existsSync(d));

      const outcome = await runNodeChallenge({
        testRunId,
        submissionFiles,
        challengeDir,
        hiddenTestFiles: run.assignment.hiddenTestFiles,
        judgeTestsDir,
        config: {
          id: run.assignment.challengeId ?? run.assignment.id,
          commands: {
            testVisible: run.assignment.workspaceConfig?.testCommand ?? "npm test",
            testHidden: "npm run test:all",
          },
        },
      });

      if (outcome.kind === "spawn-failed") {
        log.error({ error: outcome.error }, "node runner spawn failed");
        await postResults({
          testRunId,
          status: "ERROR",
          errorMessage: `runner-spawn-failed: ${outcome.error}`,
        });
        return;
      }

      if (outcome.kind === "timeout") {
        log.warn("node runner timed out");
        await postResults({
          testRunId,
          status: "ERROR",
          errorMessage: "runner timeout",
        });
        return;
      }

      if (outcome.kind === "oom") {
        log.warn("node runner hit memory cap");
        await postResults({
          testRunId,
          status: "ERROR",
          errorMessage: "runner OOM",
        });
        return;
      }

      const { report } = outcome;
      log.info(
        {
          total: report.results.length,
          visiblePassed: report.visible.passed,
          hiddenPassed: report.hidden.passed,
          status: report.status,
        },
        "node runner complete",
      );

      await postResults({
        testRunId,
        status: report.status,
        results: report.results,
        jestReport: report.rawReport,
        errorMessage: report.errorMessage,
      });
      return;
    }

    // ==========================================
    // DISPATCH: EXISTING BROWSER/SANDPACK RUNNER
    // ==========================================
    log.info("claimed; assembling workspace for browser runner");
    const workspace = await assembleWorkspace({
      testRunId,
      submissionData: run.submission.data,
      sandboxTemplate: run.assignment.sandboxTemplate,
      hiddenTestFiles: run.assignment.hiddenTestFiles,
    });
    cwd = workspace.cwd;

    log.info({ cwd }, "running browser tests");
    const outcome = await runJest(cwd);

    if (outcome.kind === "spawn-failed") {
      log.error({ error: outcome.error }, "browser spawn failed");
      await postResults({
        testRunId,
        status: "ERROR",
        errorMessage: `runner-spawn-failed: ${outcome.error}`,
      });
      return;
    }

    if (outcome.kind === "timeout") {
      log.warn("browser run timed out");
      await postResults({
        testRunId,
        status: "ERROR",
        errorMessage: "runner timeout",
      });
      return;
    }

    if (outcome.kind === "oom") {
      log.warn("browser run hit memory cap");
      await postResults({
        testRunId,
        status: "ERROR",
        errorMessage: "runner OOM",
      });
      return;
    }

    const { report } = outcome;
    log.info(
      {
        total: report.results.length,
        passed: report.results.filter((r) => r.passed).length,
        status: report.status,
      },
      "browser run complete",
    );

    await postResults({
      testRunId,
      status: report.status,
      results: report.results,
      jestReport: report.raw,
      errorMessage: report.errorMessage,
    });
  } catch (err) {
    log.error({ err }, "job failed unexpectedly");
    await postResults({
      testRunId,
      status: "ERROR",
      errorMessage: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
  } finally {
    if (cwd) {
      await cleanupWorkspace(cwd);
    }
  }
}
