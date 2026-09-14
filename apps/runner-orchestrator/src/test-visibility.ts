type Viewer = {
  role: "INSTRUCTOR" | "MENTOR" | "STUDENT" | "ADMIN" | "SUPER_ADMIN" | string;
  isOwnerOfSubmission: boolean;
};

type ResultEntry = {
  testCaseId?: string;
  title: string;
  visibility?: "VISIBLE" | "HIDDEN";
  passed: boolean;
  points?: number;
  durationMs?: number;
  output?: string;
  error?: string;
  metadata?: unknown;
  file?: string;
};

type ProjectableRun = {
  id: string;
  submissionId: string;
  assignmentId: string;
  status: string;
  visiblePassed: number;
  visibleTotal: number;
  hiddenPassed: number;
  hiddenTotal: number;
  score: number;
  maxScore: number;
  outputSummary?: unknown;
  jestReport?: unknown;
  reportArtifactId?: string | null;
  logsArtifactId?: string | null;
  [key: string]: unknown;
};

export function projectTestRunForViewer(
  run: ProjectableRun,
  attachment: { dueDate: Date | null },
  viewer: Viewer,
): ProjectableRun {
  const isStaff = viewer.role === "INSTRUCTOR" || viewer.role === "MENTOR";
  if (isStaff) return run;

  if (!viewer.isOwnerOfSubmission) {
    return {
      ...run,
      outputSummary: { results: [], hidden: true },
      jestReport: null,
      hiddenPassed: 0,
      hiddenTotal: 0,
      reportArtifactId: null,
      logsArtifactId: null,
    };
  }

  const summary = (run.outputSummary ?? {}) as { results?: ResultEntry[] };
  const visibleOnly = (summary.results ?? []).filter(
    (entry) => entry.visibility !== "HIDDEN",
  );
  const deadlinePassed = !attachment.dueDate || new Date() > attachment.dueDate;

  return {
    ...run,
    jestReport: null,
    hiddenPassed: 0,
    hiddenTotal: 0,
    reportArtifactId: null,
    logsArtifactId: null,
    outputSummary: deadlinePassed
      ? { results: visibleOnly, deadlinePassed: true }
      : {
          results: [],
          deadlinePassed: false,
          aggregateOnly: {
            visiblePassed: run.visiblePassed,
            visibleTotal: run.visibleTotal,
          },
        },
  };
}
