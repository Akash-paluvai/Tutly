import { chmod, mkdir, rm, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

import { env } from "./env.js";

export type NodeSubmissionFile =
  | string
  | {
      code?: string;
      hidden?: boolean;
    };

export type NodeChallengeConfig = {
  id: string;
  title?: string;
  language?: string;
  runtime?: string;
  commands?: {
    install?: string;
    testVisible?: string;
    testHidden?: string;
  };
};

export type NodeWorkspace = {
  cwd: string;
  visibleTestPaths: string[];
  hiddenTestPaths: string[];
  mode: "visible" | "hidden";
};

const FORBIDDEN_FILE_NAMES = new Set([
  "challenge.json",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "jest.config.js",
  "jest.config.ts",
  "jest.config.mjs",
  "jest.config.cjs",
  "tsconfig.json",
]);

const FORBIDDEN_PREFIXES = [
  "__hidden__/",
  "tests/",
  ".git/",
  "node_modules/",
];

const MAX_FILES = 50;
const MAX_FILE_SIZE = 256 * 1024; // 256 KB
const MAX_TOTAL_SIZE = 2 * 1024 * 1024; // 2 MB

function fileContent(entry: NodeSubmissionFile): string {
  if (typeof entry === "string") return entry;
  return entry.code ?? "";
}

function normalizePath(p: string): string {
  let norm = p.startsWith("/") ? p.slice(1) : p;
  norm = norm.replace(/\\/g, "/");
  return path.normalize(norm);
}

// Join an untrusted relative path under a trusted base, strictly rejecting traversal and null bytes.
export function safeJoin(base: string, rel: string): string {
  if (rel.includes("\0")) {
    throw new Error("invalid path: null byte detected");
  }
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, rel);
  if (
    resolved !== resolvedBase &&
    !resolved.startsWith(resolvedBase + path.sep)
  ) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  return resolved;
}

/**
 * Validates untrusted file path submitted by participant.
 * Rejects path traversal, forbidden prefixes (like __hidden__, tests, node_modules),
 * and forbidden file names (like package.json, jest.config.js, challenge.json).
 */
export function validateSubmissionFilePath(rawPath: string): string {
  if (rawPath.includes("\0")) {
    throw new Error(`invalid path: null byte in ${rawPath}`);
  }

  const normalized = normalizePath(rawPath);

  if (
    normalized.startsWith("..") ||
    path.isAbsolute(rawPath) ||
    normalized.split("/").some((seg) => seg === "..")
  ) {
    throw new Error(`path escapes workspace: ${rawPath}`);
  }

  const baseName = path.basename(normalized);
  if (FORBIDDEN_FILE_NAMES.has(baseName)) {
    throw new Error(`protected file cannot be submitted: ${rawPath}`);
  }

  for (const prefix of FORBIDDEN_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized === prefix.slice(0, -1)) {
      throw new Error(`protected path prefix cannot be submitted: ${rawPath}`);
    }
  }

  return normalized;
}

export type AssembleNodeWorkspaceOpts = {
  testRunId: string;
  mode: "visible" | "hidden";
  submissionFiles: Record<string, NodeSubmissionFile>;
  challengeDir?: string;
  challengeFiles?: Record<string, NodeSubmissionFile>;
  hiddenTestFiles?: Record<string, string> | null;
  judgeTestsDir?: string;
  challengeId?: string;
};

/**
 * Assembles a physical filesystem workspace for isolated Node container execution.
 * Creates an isolated directory for the given testMode ('visible' or 'hidden').
 */
export async function assembleNodeWorkspace(
  opts: AssembleNodeWorkspaceOpts,
): Promise<NodeWorkspace> {
  const sanitizedRunId = path
    .basename(opts.testRunId)
    .replace(/[^a-zA-Z0-9_-]/g, "");
  const cwd = path.resolve(
    env.WORK_DIR,
    `node-run-${sanitizedRunId}-${opts.mode}-${Date.now()}`,
  );

  await mkdir(cwd, { recursive: true });
  await chmod(cwd, 0o777);

  const visibleTestPaths: string[] = [];
  const hiddenTestPaths: string[] = [];

  try {
    // 1. Validate & write student submission files
    const fileEntries = Object.entries(opts.submissionFiles || {});
    if (fileEntries.length > MAX_FILES) {
      throw new Error(`too many files submitted (max ${MAX_FILES})`);
    }

    let totalSize = 0;
    for (const [rawPath, entry] of fileEntries) {
      const safeRelative = validateSubmissionFilePath(rawPath);
      const content = fileContent(entry);
      const byteSize = Buffer.byteLength(content, "utf8");

      if (byteSize > MAX_FILE_SIZE) {
        throw new Error(
          `file too large: ${rawPath} exceeds ${MAX_FILE_SIZE} bytes`,
        );
      }
      totalSize += byteSize;
      if (totalSize > MAX_TOTAL_SIZE) {
        throw new Error(
          `total submission size exceeds ${MAX_TOTAL_SIZE} bytes`,
        );
      }

      const destPath = safeJoin(cwd, safeRelative);
      await mkdir(path.dirname(destPath), { recursive: true });
      await writeFile(destPath, content, "utf8");
    }

    // 2. Inject trusted challenge files (package.json, pnpm-lock, visible tests)
    // Priority A: From physical challengeDir on disk if provided
    if (opts.challengeDir && existsSync(opts.challengeDir)) {
      await copyChallengeAssetsFromDisk(opts.challengeDir, cwd, visibleTestPaths);
    }

    // Priority B: From in-memory challengeFiles (e.g. from DB template or S3)
    if (opts.challengeFiles) {
      for (const [filePath, entry] of Object.entries(opts.challengeFiles)) {
        const norm = normalizePath(filePath);
        // Student cannot overwrite, but challenge files can write package.json, tests, etc.
        const dest = safeJoin(cwd, norm);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, fileContent(entry), "utf8");
        if (norm.startsWith("tests/")) {
          visibleTestPaths.push(norm);
        }
      }
    }

    // 3. In hidden mode ONLY, inject server-side hidden tests into __hidden__/
    if (opts.mode === "hidden") {
      const hiddenDir = safeJoin(cwd, "__hidden__");
      await mkdir(hiddenDir, { recursive: true });

      // Option A: From hiddenTestFiles Record<path, code>
      if (opts.hiddenTestFiles && Object.keys(opts.hiddenTestFiles).length > 0) {
        for (const [relPath, code] of Object.entries(opts.hiddenTestFiles)) {
          let cleanRel = normalizePath(relPath);
          if (cleanRel.startsWith("__hidden__/")) {
            cleanRel = cleanRel.slice("__hidden__/".length);
          }
          const target = safeJoin(hiddenDir, cleanRel);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, code, "utf8");
          hiddenTestPaths.push(`__hidden__/${cleanRel}`);
        }
      }

      // Option B: From judgeTestsDir on disk if provided (e.g. judge-tests/<challengeId>)
      if (opts.judgeTestsDir && existsSync(opts.judgeTestsDir)) {
        await cp(opts.judgeTestsDir, hiddenDir, { recursive: true });
        hiddenTestPaths.push("__hidden__/*");
      }
    }

    return {
      cwd,
      visibleTestPaths,
      hiddenTestPaths,
      mode: opts.mode,
    };
  } catch (err) {
    // If assembly fails, clean up immediately
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

async function copyChallengeAssetsFromDisk(
  challengeDir: string,
  workDir: string,
  visibleTestPaths: string[],
): Promise<void> {
  // 1. Copy package.json
  const pkgPath = path.join(challengeDir, "package.json");
  if (existsSync(pkgPath)) {
    await cp(pkgPath, path.join(workDir, "package.json"));
  }

  // 2. Copy lockfile
  const pnpmLock = path.join(challengeDir, "pnpm-lock.yaml");
  if (existsSync(pnpmLock)) {
    await cp(pnpmLock, path.join(workDir, "pnpm-lock.yaml"));
  }

  // 3. Copy visible tests
  const testsSource = path.join(challengeDir, "tests");
  if (existsSync(testsSource)) {
    const testsDest = path.join(workDir, "tests");
    await cp(testsSource, testsDest, { recursive: true });
    visibleTestPaths.push("tests/*");
  }
}

/**
 * Robust cleanup of workspace directory.
 */
export async function cleanupNodeWorkspace(cwd: string): Promise<void> {
  const workRoot = path.resolve(env.WORK_DIR);
  const resolved = path.resolve(cwd);

  // Security guard: Ensure we only delete directories inside WORK_DIR
  if (resolved !== workRoot && resolved.startsWith(workRoot + path.sep)) {
    await rm(resolved, { recursive: true, force: true }).catch(() => undefined);
  }
}
