export type JestAssertionResult = {
  ancestorTitles: string[];
  duration?: number | null;
  failureDetails?: unknown[];
  failureMessages?: string[];
  fullName?: string;
  status: "passed" | "failed" | "pending" | "todo" | "disabled";
  title: string;
};

export type JestTestResult = {
  assertionResults: JestAssertionResult[];
  endTime?: number;
  message?: string;
  name: string; // File path: e.g. /submission/tests/product.visible.test.js or /submission/__hidden__/product.hidden.test.js
  startTime?: number;
  status: "passed" | "failed";
  summary?: string;
};

export type JestReport = {
  numFailedTestSuites: number;
  numFailedTests: number;
  numPassedTestSuites: number;
  numPassedTests: number;
  numPendingTestSuites: number;
  numPendingTests: number;
  numTotalTestSuites: number;
  numTotalTests: number;
  success: boolean;
  testResults: JestTestResult[];
  wasInterrupted?: boolean;
};

export type MappedNodeTest = {
  testCaseId?: string;
  title: string;
  visibility: "VISIBLE" | "HIDDEN";
  passed: boolean;
  points?: number;
  durationMs?: number;
  output?: string;
  error?: string;
};

export type MappedNodeReport = {
  status: "PASSED" | "FAILED" | "ERROR";
  results: MappedNodeTest[];
  errorMessage?: string;
  visible: {
    passed: number;
    failed: number;
    total: number;
  };
  hidden: {
    passed: number;
    failed: number;
    total: number;
  };
  rawReport?: unknown;
};

function normalizeJestFilePath(name: string): string {
  let p = name.replace(/\\/g, "/");
  const subIdx = p.indexOf("/submission/");
  if (subIdx !== -1) {
    p = p.slice(subIdx + "/submission/".length);
  }
  return p.startsWith("/") ? p.slice(1) : p;
}

function determineVisibility(filePath: string): "VISIBLE" | "HIDDEN" {
  const norm = normalizeJestFilePath(filePath);
  return norm.startsWith("__hidden__") || norm.includes("/__hidden__/")
    ? "HIDDEN"
    : "VISIBLE";
}

function formatTestTitle(
  filePath: string,
  ancestors: string[] | undefined,
  title: string,
): string {
  const relPath = normalizeJestFilePath(filePath);
  const trail = [...(ancestors ?? []), title].filter(Boolean).join(" > ");
  return `${relPath} > ${trail}`;
}

function formatTestError(assertion: JestAssertionResult): string | undefined {
  if (assertion.status === "passed") return undefined;
  if (!assertion.failureMessages || assertion.failureMessages.length === 0) {
    return "test assertion failed";
  }
  return assertion.failureMessages.join("\n\n");
}

/**
 * Parses a single Jest run output into mapped results and counts.
 */
export function parseJestJson(rawJson: string | JestReport): {
  ok: boolean;
  report?: JestReport;
  results: MappedNodeTest[];
  passedTests: number;
  failedTests: number;
  totalTests: number;
  error?: string;
} {
  let report: JestReport;
  if (typeof rawJson === "string") {
    try {
      report = JSON.parse(rawJson) as JestReport;
    } catch (err) {
      return {
        ok: false,
        results: [],
        passedTests: 0,
        failedTests: 0,
        totalTests: 0,
        error: `failed to parse Jest JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    report = rawJson;
  }

  const results: MappedNodeTest[] = [];

  for (const suite of report.testResults ?? []) {
    const visibility = determineVisibility(suite.name);

    if (suite.assertionResults && suite.assertionResults.length > 0) {
      for (const assertion of suite.assertionResults) {
        results.push({
          title: formatTestTitle(suite.name, assertion.ancestorTitles, assertion.title),
          visibility,
          passed: assertion.status === "passed",
          durationMs:
            typeof assertion.duration === "number"
              ? Math.round(assertion.duration)
              : undefined,
          error: formatTestError(assertion),
        });
      }
    } else if (suite.status === "failed") {
      // Entire test suite failed to compile/execute (e.g. syntax error in suite)
      results.push({
        title: `${normalizeJestFilePath(suite.name)} > <suite failure>`,
        visibility,
        passed: false,
        error: suite.message || "test file failed to execute",
      });
    }
  }

  const passedTests = report.numPassedTests ?? results.filter((r) => r.passed).length;
  const failedTests = report.numFailedTests ?? results.filter((r) => !r.passed).length;
  const totalTests = report.numTotalTests ?? results.length;

  return {
    ok: true,
    report,
    results,
    passedTests,
    failedTests,
    totalTests,
  };
}

/**
 * Combines Phase 1 (visible) and Phase 2 (hidden) outcomes into a final normalized report.
 *
 * In challenge-001:
 * Phase 1 (visible): 4 tests.
 * Phase 2 (hidden/all): 8 tests (4 visible + 4 hidden).
 */
export function combineTwoPhaseResults(opts: {
  visibleOutcome: ReturnType<typeof parseJestJson>;
  hiddenOutcome: ReturnType<typeof parseJestJson>;
  visibleTimedOut?: boolean;
  hiddenTimedOut?: boolean;
  visibleError?: string;
  hiddenError?: string;
}): MappedNodeReport {
  const { visibleOutcome, hiddenOutcome } = opts;

  if (opts.visibleTimedOut || opts.hiddenTimedOut) {
    return {
      status: "ERROR",
      results: [],
      errorMessage: opts.visibleTimedOut
        ? "visible test run timed out"
        : "hidden test run timed out",
      visible: { passed: 0, failed: 0, total: 0 },
      hidden: { passed: 0, failed: 0, total: 0 },
    };
  }

  if (!visibleOutcome.ok || opts.visibleError) {
    return {
      status: "ERROR",
      results: [],
      errorMessage: opts.visibleError ?? visibleOutcome.error ?? "visible test execution failed",
      visible: { passed: 0, failed: 0, total: 0 },
      hidden: { passed: 0, failed: 0, total: 0 },
    };
  }

  if (!hiddenOutcome.ok || opts.hiddenError) {
    return {
      status: "ERROR",
      results: visibleOutcome.results,
      errorMessage: opts.hiddenError ?? hiddenOutcome.error ?? "hidden test execution failed",
      visible: {
        passed: visibleOutcome.passedTests,
        failed: visibleOutcome.failedTests,
        total: visibleOutcome.totalTests,
      },
      hidden: { passed: 0, failed: 0, total: 0 },
    };
  }

  // Phase 1 tests are the verified visible test cases
  const visibleResults = visibleOutcome.results.filter((r) => r.visibility === "VISIBLE");
  const visiblePassed = visibleResults.filter((r) => r.passed).length;
  const visibleTotal = visibleResults.length;
  const visibleFailed = visibleTotal - visiblePassed;

  // From Phase 2 (which ran visible + hidden), extract the HIDDEN test cases
  const hiddenResults = hiddenOutcome.results.filter((r) => r.visibility === "HIDDEN");
  const hiddenPassed = hiddenResults.filter((r) => r.passed).length;
  const hiddenTotal = hiddenResults.length;
  const hiddenFailed = hiddenTotal - hiddenPassed;

  // Combined results array: all visible tests from Phase 1 + all hidden tests from Phase 2
  const combinedResults: MappedNodeTest[] = [...visibleResults, ...hiddenResults];

  // Overall status: PASSED only if zero visible failures AND zero hidden failures AND at least 1 test ran
  const allPassed =
    visibleFailed === 0 &&
    hiddenFailed === 0 &&
    combinedResults.length > 0;

  return {
    status: allPassed ? "PASSED" : "FAILED",
    results: combinedResults,
    visible: {
      passed: visiblePassed,
      failed: visibleFailed,
      total: visibleTotal,
    },
    hidden: {
      passed: hiddenPassed,
      failed: hiddenFailed,
      total: hiddenTotal,
    },
    rawReport: {
      visible: visibleOutcome.report,
      hidden: hiddenOutcome.report,
    },
  };
}
