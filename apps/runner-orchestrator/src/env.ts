import { z } from "zod";

const schema = z.object({
  TEST_RUNNER_PORT: z
    .string()
    .default("3010")
    .transform((s) => Number(s)),
  TEST_RUNNER_SECRET: z
    .string()
    .min(16, "TEST_RUNNER_SECRET must be at least 16 chars")
    .default("test-secret-at-least-16-chars-long"),

  WEB_BASE_URL: z.string().url().default("http://localhost:3000"),

  WORK_DIR: z.string().default("/tmp/tutly-runner"),
  RUNTIME_DIR: z.string().default("/tmp"),

  CONCURRENCY: z
    .string()
    .default("2")
    .transform((s) => Number(s)),
  JOB_TIMEOUT_MS: z
    .string()
    .default("120000")
    .transform((s) => Number(s)),
  JOB_MEMORY_MB: z
    .string()
    .default("640")
    .transform((s) => Number(s)),
  JOB_CPU_LIMIT: z
    .string()
    .default("1.0")
    .transform((s) => Number(s)),
  JOB_PIDS_LIMIT: z
    .string()
    .default("128")
    .transform((s) => Number(s)),

  USE_DOCKER: z
    .string()
    .default("true")
    .transform((s) => s === "true" || s === "1"),
  BROWSER_IMAGE: z
    .string()
    .default("ghcr.io/tutlylabs/tutly-browser-runner:latest"),
  NODE_IMAGE: z
    .string()
    .default("tutly/node-runner:22"),
  // Host path the Docker daemon sees when bind-mounting WORK_DIR. Defaults to WORK_DIR.
  WORK_DIR_HOST: z.string().optional(),

  DATABASE_URL: z
    .string()
    .default("postgres://postgres:postgres@localhost:5432/tutly"),

  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error"])
    .default("info"),
});

export const env = schema.parse(process.env);
