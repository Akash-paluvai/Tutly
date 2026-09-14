import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

import { env } from "./env.js";
import { logger } from "./logger.js";
import {
  assembleNodeWorkspace,
  cleanupNodeWorkspace,
  type NodeChallengeConfig,
  type NodeSubmissionFile,
} from "./node-sandbox.js";
import {
  combineTwoPhaseResults,
  parseJestJson,
  type MappedNodeReport,
} from "./node-result-mapper.js";

export type NodeRunOutcome =
  | { kind: "completed"; report: MappedNodeReport; durationMs: number; stderrTail: string }
  | { kind: "timeout"; durationMs: number; stderrTail: string }
  | { kind: "oom"; durationMs: number; stderrTail: string }
  | { kind: "spawn-failed"; error: string };

type SingleContainerOutcome =
  | { kind: "completed"; rawJson: string; durationMs: number; exitCode: number | null; stderrTail: string }
  | { kind: "timeout"; durationMs: number; stderrTail: string }
  | { kind: "oom"; durationMs: number; stderrTail: string }
  | { kind: "spawn-failed"; error: string };

function toHostPath(localPath: string): string {
  if (!env.WORK_DIR_HOST || env.WORK_DIR_HOST === env.WORK_DIR) {
    return localPath;
  }
  const rel = path.relative(env.WORK_DIR, localPath);
  return path.join(env.WORK_DIR_HOST, rel);
}

export function buildDockerRunArgs(opts: {
  hostCwd: string;
  containerName: string;
  testCommand: string;
  image?: string;
}): string[] {
  const image = opts.image ?? env.NODE_IMAGE ?? "tutly/node-runner:22";
  const memoryMb = env.JOB_MEMORY_MB ?? 512;
  const cpuLimit = env.JOB_CPU_LIMIT ?? "1.0";
  const pidsLimit = env.JOB_PIDS_LIMIT ?? 128;

  return [
    "run",
    "--rm",
    "--name",
    opts.containerName,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=128m",
    "--network=none",
    `--memory=${memoryMb}m`,
    `--memory-swap=${memoryMb}m`,
    `--cpus=${cpuLimit}`,
    `--pids-limit=${pidsLimit}`,
    "--security-opt=no-new-privileges",
    "--cap-drop=ALL",
    "-v",
    `${opts.hostCwd}:/submission:rw`,
    "-w",
    "/submission",
    image,
    "sh",
    "-c",
    opts.testCommand,
  ];
}

/**
 * Spawns a hardened Docker container to execute a single test command inside the workspace.
 */
async function executeContainer(opts: {
  cwd: string;
  containerName: string;
  testCommand: string;
  timeoutMs: number;
}): Promise<SingleContainerOutcome> {
  const hostCwd = toHostPath(path.resolve(opts.cwd));
  const cmdArgs = buildDockerRunArgs({
    hostCwd,
    containerName: opts.containerName,
    testCommand: opts.testCommand,
  });

  logger.debug(
    { containerName: opts.containerName, hostCwd, testCommand: opts.testCommand },
    "spawning node runner docker container",
  );

  const startTime = Date.now();

  return await new Promise<SingleContainerOutcome>((resolve) => {
    let resolved = false;
    let stderrBuf = "";

    const child = spawn("docker", cmdArgs, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killContainer = async () => {
      await new Promise<void>((done) => {
        const killer = spawn("docker", ["kill", opts.containerName], {
          stdio: "ignore",
        });
        killer.on("exit", () => done());
        killer.on("error", () => done());
        setTimeout(() => done(), 3000);
      });
    };

    const finalize = async (outcome: SingleContainerOutcome) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(watchdogTimer);
      if (outcome.kind === "timeout" || outcome.kind === "oom") {
        await killContainer();
      }
      resolve(outcome);
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf-8");
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
    });

    child.on("error", (err) => {
      finalize({ kind: "spawn-failed", error: err.message });
    });

    child.on("exit", async (code, signal) => {
      const durationMs = Date.now() - startTime;
      if (code === 137) {
        finalize({ kind: "oom", durationMs, stderrTail: stderrBuf });
        return;
      }
      if (signal === "SIGKILL" && !resolved) {
        finalize({ kind: "timeout", durationMs, stderrTail: stderrBuf });
        return;
      }

      const resultsFile = path.join(opts.cwd, "jest-results.json");
      let rawJson = "";
      if (existsSync(resultsFile)) {
        try {
          rawJson = await readFile(resultsFile, "utf-8");
        } catch {
          rawJson = "";
        }
      }

      finalize({
        kind: "completed",
        rawJson,
        durationMs,
        exitCode: code,
        stderrTail: stderrBuf,
      });
    });

    const watchdogTimer = setTimeout(() => {
      logger.warn({ containerName: opts.containerName }, "node container execution timed out");
      finalize({
        kind: "timeout",
        durationMs: Date.now() - startTime,
        stderrTail: stderrBuf,
      });
    }, opts.timeoutMs);
  });
}

export type RunNodeChallengeOpts = {
  testRunId: string;
  submissionFiles: Record<string, NodeSubmissionFile>;
  challengeDir?: string;
  challengeFiles?: Record<string, NodeSubmissionFile>;
  hiddenTestFiles?: Record<string, string> | null;
  judgeTestsDir?: string;
  config?: NodeChallengeConfig;
  timeoutMs?: number;
};

/**
 * Runs a Node.js challenge using the proven two-phase model:
 * Phase 1 (Visible): Runs visible tests in fresh isolated workspace.
 * Phase 2 (Hidden): Runs full visible + hidden tests in separate fresh workspace.
 * Cleans up both workspaces and all containers in finally blocks.
 */
export async function runNodeChallenge(
  opts: RunNodeChallengeOpts,
): Promise<NodeRunOutcome> {
  const timeout = opts.timeoutMs ?? Math.min(env.JOB_TIMEOUT_MS, 45_000);
  const sanitizedRunId = path
    .basename(opts.testRunId)
    .replace(/[^a-zA-Z0-9_-]/g, "");

  const visibleCmdBase = opts.config?.commands?.testVisible ?? "npm test";
  const hiddenCmdBase = opts.config?.commands?.testHidden ?? "npm run test:all";

  const visibleTestCommand = `${visibleCmdBase} -- --json --outputFile=/submission/jest-results.json`;
  const hiddenTestCommand = `${hiddenCmdBase} -- --json --outputFile=/submission/jest-results.json`;

  let visibleCwd: string | undefined;
  let hiddenCwd: string | undefined;
  let totalDurationMs = 0;

  try {
    // ==========================================
    // PHASE 1: VISIBLE TEST EXECUTION
    // ==========================================
    const visibleContainerName = `tutly-node-${sanitizedRunId}-vis`;
    logger.info({ testRunId: opts.testRunId }, "assembling Phase 1 (visible) workspace");

    const visibleWorkspace = await assembleNodeWorkspace({
      testRunId: opts.testRunId,
      mode: "visible",
      submissionFiles: opts.submissionFiles,
      challengeDir: opts.challengeDir,
      challengeFiles: opts.challengeFiles,
      hiddenTestFiles: null, // Zero hidden tests in visible phase
    });
    visibleCwd = visibleWorkspace.cwd;

    logger.info({ cwd: visibleCwd }, "executing Phase 1 (visible) container");
    const visibleOutcome = await executeContainer({
      cwd: visibleCwd,
      containerName: visibleContainerName,
      testCommand: visibleTestCommand,
      timeoutMs: timeout,
    });

    totalDurationMs += visibleOutcome.kind === "completed" ? visibleOutcome.durationMs : 0;

    if (visibleOutcome.kind === "spawn-failed") {
      return { kind: "spawn-failed", error: visibleOutcome.error };
    }
    if (visibleOutcome.kind === "timeout") {
      return { kind: "timeout", durationMs: totalDurationMs, stderrTail: visibleOutcome.stderrTail };
    }
    if (visibleOutcome.kind === "oom") {
      return { kind: "oom", durationMs: totalDurationMs, stderrTail: visibleOutcome.stderrTail };
    }

    const parsedVisible = parseJestJson(visibleOutcome.rawJson);

    // ==========================================
    // PHASE 2: HIDDEN TEST EXECUTION
    // ==========================================
    const hiddenContainerName = `tutly-node-${sanitizedRunId}-hid`;
    logger.info({ testRunId: opts.testRunId }, "assembling Phase 2 (hidden) workspace");

    const hiddenWorkspace = await assembleNodeWorkspace({
      testRunId: opts.testRunId,
      mode: "hidden",
      submissionFiles: opts.submissionFiles,
      challengeDir: opts.challengeDir,
      challengeFiles: opts.challengeFiles,
      hiddenTestFiles: opts.hiddenTestFiles,
      judgeTestsDir: opts.judgeTestsDir,
    });
    hiddenCwd = hiddenWorkspace.cwd;

    logger.info({ cwd: hiddenCwd }, "executing Phase 2 (hidden) container");
    const hiddenOutcome = await executeContainer({
      cwd: hiddenCwd,
      containerName: hiddenContainerName,
      testCommand: hiddenTestCommand,
      timeoutMs: timeout,
    });

    totalDurationMs += hiddenOutcome.kind === "completed" ? hiddenOutcome.durationMs : 0;

    if (hiddenOutcome.kind === "spawn-failed") {
      return { kind: "spawn-failed", error: hiddenOutcome.error };
    }
    if (hiddenOutcome.kind === "timeout") {
      return { kind: "timeout", durationMs: totalDurationMs, stderrTail: hiddenOutcome.stderrTail };
    }
    if (hiddenOutcome.kind === "oom") {
      return { kind: "oom", durationMs: totalDurationMs, stderrTail: hiddenOutcome.stderrTail };
    }

    const parsedHidden = parseJestJson(hiddenOutcome.rawJson);

    // ==========================================
    // COMBINE OUTCOMES INTO NORMALIZED REPORT
    // ==========================================
    const report = combineTwoPhaseResults({
      visibleOutcome: parsedVisible,
      hiddenOutcome: parsedHidden,
    });

    logger.info(
      {
        testRunId: opts.testRunId,
        status: report.status,
        visible: report.visible,
        hidden: report.hidden,
      },
      "two-phase node run complete",
    );

    return {
      kind: "completed",
      report,
      durationMs: totalDurationMs,
      stderrTail: hiddenOutcome.stderrTail,
    };
  } finally {
    // Guaranteed cleanup of workspaces
    if (visibleCwd) {
      await cleanupNodeWorkspace(visibleCwd);
    }
    if (hiddenCwd) {
      await cleanupNodeWorkspace(hiddenCwd);
    }
  }
}
