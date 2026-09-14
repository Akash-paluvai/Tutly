import { z } from "zod";

const schema = z.object({
  STORAGE_S3_ENDPOINT: z.string().url(),
  STORAGE_S3_REGION: z.string().default("us-east-1"),
  STORAGE_S3_BUCKET: z.string().min(1),
  STORAGE_S3_ACCESS_KEY: z.string().min(1),
  STORAGE_S3_SECRET_KEY: z.string().min(1),
  STORAGE_S3_FORCE_PATH_STYLE: z
    .string()
    .default("false")
    .transform((s) => s === "true" || s === "1"),
});

type Env = z.infer<typeof schema>;

// Parse on first access, not at module load — Next.js build-time page
// collection imports this transitively, and STORAGE_S3_* aren't set in CI.
let _env: Env | null = null;
function load(): Env {
  if (_env) return _env;
  const raw = {
    STORAGE_S3_ENDPOINT:
      process.env.STORAGE_S3_ENDPOINT ||
      process.env.AWS_ENDPOINT ||
      "http://localhost:9000",
    STORAGE_S3_REGION:
      process.env.STORAGE_S3_REGION ||
      process.env.AWS_BUCKET_REGION ||
      "us-east-1",
    STORAGE_S3_BUCKET:
      process.env.STORAGE_S3_BUCKET ||
      process.env.AWS_BUCKET_NAME ||
      "tutly-local",
    STORAGE_S3_ACCESS_KEY:
      process.env.STORAGE_S3_ACCESS_KEY ||
      process.env.AWS_ACCESS_KEY ||
      "tutlydev",
    STORAGE_S3_SECRET_KEY:
      process.env.STORAGE_S3_SECRET_KEY ||
      process.env.AWS_SECRET_KEY ||
      "tutlydev123",
    STORAGE_S3_FORCE_PATH_STYLE:
      process.env.STORAGE_S3_FORCE_PATH_STYLE || "true",
  };
  _env = schema.parse(raw);
  return _env;
}

export const env = new Proxy({} as Env, {
  get(_, prop) {
    return load()[prop as keyof Env];
  },
}) as Env;
