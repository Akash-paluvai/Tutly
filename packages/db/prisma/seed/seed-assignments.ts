import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "../generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { writeSandpackTemplate, writeHiddenTests, type Locator } from "../../../storage/src/index.ts";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});
const prisma = new PrismaClient({ adapter });

async function seedAssignments() {
  console.log("🌱 Seeding Feature Flags, Course Class, and Node Full-Stack Assignments...");

  // 1. Feature Flags
  const flags = [
    { key: "sandbox_submission", enabled: true },
    { key: "sandbox_templates", enabled: true },
    { key: "workspace_providers", enabled: true },
    { key: "ai_assistant", enabled: true },
    { key: "integrations_tab", enabled: true },
  ];

  for (const f of flags) {
    await prisma.featureFlag.upsert({
      where: { key: f.key },
      create: { key: f.key, enabled: f.enabled },
      update: { enabled: f.enabled },
    });
    console.log(`  ✓ FeatureFlag: ${f.key} = true`);
  }

  // 2. Fetch Course 1 and instructor
  const course = await prisma.course.findFirst({
    include: {
      createdBy: true,
      enrolledUsers: true,
    },
  });

  if (!course) {
    throw new Error("No course found in database! Please run `make load-dummy-data` first.");
  }

  console.log(`  ✓ Found Course: "${course.title}" (${course.id}) with ${course.enrolledUsers.length} enrolled users`);

  // 3. Create Video & Class
  const video = await prisma.video.upsert({
    where: { id: "vid-node-fullstack-01" },
    create: {
      id: "vid-node-fullstack-01",
      videoType: "YOUTUBE",
      videoLink: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      status: "READY",
    },
    update: {},
  });

  const classItem = await prisma.class.upsert({
    where: { id: "class-node-fullstack-01" },
    create: {
      id: "class-node-fullstack-01",
      title: "Module 1: Building Scalable REST APIs with Express",
      courseId: course.id,
      videoId: video.id,
    },
    update: {
      title: "Module 1: Building Scalable REST APIs with Express",
    },
  });
  console.log(`  ✓ Created Class: "${classItem.title}" (${classItem.id})`);

  // 4. Assignment 1: Workspace Mode (Local / VS Code / Docker Evaluation)
  const asgWorkspaceId = "asg-node-challenge-workspace";
  const asgWorkspace = await prisma.attachment.upsert({
    where: { id: asgWorkspaceId },
    create: {
      id: asgWorkspaceId,
      title: "Challenge 001: Node.js Full-Stack API (Workspace Mode)",
      details: `### Challenge: Fix Product Management REST API

In this challenge, you are provided with an Express.js backend that has several bugs in its product management endpoints.

#### Your Tasks:
1. **GET /api/health**: Return status 200 with \`{ "status": "ok" }\`.
2. **POST /api/products**: Return status 201 with the newly created product object. Ensure \`tags\` is an array with at least 3 items (return 400 with \`{ "error": "At least 3 tags are required" }\` if invalid).
3. **DELETE /api/products/:id**: Check if product exists. Return 404 with \`{ "error": "Product not found" }\` if missing. Permanently delete only the requested product and return 200 with \`{ "message": "Product deleted successfully" }\`.

#### Testing & Submission:
- Run \`npm test\` to verify your visible cases (4/4 passed).
- When ready, submit your workspace to trigger automated judging against all test suites.`,
      attachmentType: "ASSIGNMENT",
      submissionMode: "WORKSPACE",
      courseId: course.id,
      classId: classItem.id,
      maxSubmissions: 20,
      hiddenTestFiles: [
        "tests/01-health.judge.test.js",
        "tests/02-products.judge.test.js",
        "tests/03-cart.judge.test.js",
        "tests/04-auth.judge.test.js",
      ],
    },
    update: {
      title: "Challenge 001: Node.js Full-Stack API (Workspace Mode)",
      courseId: course.id,
      classId: classItem.id,
      submissionMode: "WORKSPACE",
      maxSubmissions: 20,
      hiddenTestFiles: [
        "tests/01-health.judge.test.js",
        "tests/02-products.judge.test.js",
        "tests/03-cart.judge.test.js",
        "tests/04-auth.judge.test.js",
      ],
    },
  });

  await prisma.assignmentConfig.upsert({
    where: { assignmentId: asgWorkspaceId },
    create: {
      assignmentId: asgWorkspaceId,
      setupCommand: "npm install",
      devCommand: "npm start",
      testCommand: "npm test",
      previewPorts: [3001],
      defaultProvider: "LOCAL",
    },
    update: {
      setupCommand: "npm install",
      devCommand: "npm start",
      testCommand: "npm test",
      previewPorts: [3001],
    },
  });
  console.log(`  ✓ Created Assignment 1 (Workspace): "${asgWorkspace.title}" (${asgWorkspace.id})`);

  // 5. Assignment 2: In-Browser Sandbox Playground Mode
  const asgSandboxId = "asg-node-challenge-sandbox";
  const asgSandbox = await prisma.attachment.upsert({
    where: { id: asgSandboxId },
    create: {
      id: asgSandboxId,
      title: "Challenge 002: Node.js Full-Stack API (In-Browser Sandbox)",
      details: `### In-Browser Playground Challenge

Fix the Express.js product management endpoints directly in your browser using the Sandpack playground.

Click **Submit through Playground** to launch the code editor, fix the bugs in \`backend/controllers/productController.js\`, run visible tests, and submit!`,
      attachmentType: "ASSIGNMENT",
      submissionMode: "SANDBOX",
      courseId: course.id,
      classId: classItem.id,
      maxSubmissions: 20,
      hiddenTestFiles: [
        "tests/01-health.judge.test.js",
        "tests/02-products.judge.test.js",
        "tests/03-cart.judge.test.js",
        "tests/04-auth.judge.test.js",
      ],
    },
    update: {
      title: "Challenge 002: Node.js Full-Stack API (In-Browser Sandbox)",
      courseId: course.id,
      classId: classItem.id,
      submissionMode: "SANDBOX",
      maxSubmissions: 20,
      hiddenTestFiles: [
        "tests/01-health.judge.test.js",
        "tests/02-products.judge.test.js",
        "tests/03-cart.judge.test.js",
        "tests/04-auth.judge.test.js",
      ],
    },
  });

  // Read fixture files for Sandpack template
  const fixtureDir = path.resolve(
    process.cwd(),
    "apps/runner-orchestrator/fixtures/challenge-001",
  );

  const serverJs = fs.readFileSync(path.join(fixtureDir, "backend/server.js"), "utf8");
  const controllerJs = fs.readFileSync(path.join(fixtureDir, "backend/controllers/productController.js"), "utf8");
  const productsJs = fs.readFileSync(path.join(fixtureDir, "backend/data/products.js"), "utf8");
  const routesJs = fs.readFileSync(path.join(fixtureDir, "backend/routes/productRoutes.js"), "utf8");
  const visibleTestJs = fs.readFileSync(path.join(fixtureDir, "tests/product.visible.test.js"), "utf8");
  const packageJson = fs.readFileSync(path.join(fixtureDir, "package.json"), "utf8");

  const locator: Locator = {
    orgId: course.createdBy?.organizationId ?? null,
    courseId: course.id,
    assignmentId: asgSandboxId,
  };

  const sandpackTemplate = {
    template: "node",
    files: {
      "/backend/server.js": { code: serverJs },
      "/backend/controllers/productController.js": { code: controllerJs },
      "/backend/data/products.js": { code: productsJs },
      "/backend/routes/productRoutes.js": { code: routesJs },
      "/tests/product.visible.test.js": { code: visibleTestJs },
      "/package.json": { code: packageJson },
      "/tutly.json": {
        code: JSON.stringify({
          version: 1,
          showFileExplorer: true,
          entry: "/backend/server.js",
        }),
      },
    },
    options: {
      showFileExplorer: true,
      activeFile: "/backend/controllers/productController.js",
    },
  };

  await writeSandpackTemplate(locator, sandpackTemplate);
  console.log(`  ✓ Wrote Sandpack template to MinIO storage for ${asgSandboxId}`);

  // Also write template for workspace assignment so in-browser playground works seamlessly
  const workspaceLocator: Locator = {
    orgId: course.createdBy?.organizationId ?? null,
    courseId: course.id,
    assignmentId: asgWorkspaceId,
  };
  await writeSandpackTemplate(workspaceLocator, sandpackTemplate);
  console.log(`  ✓ Wrote Sandpack template to MinIO storage for ${asgWorkspaceId}`);

  // Also write judge hidden tests for the sandbox runner
  const judgeDir = path.resolve(
    process.cwd(),
    "apps/runner-orchestrator/fixtures/judge-tests/challenge-001",
  );
  const hiddenTestJs = fs.readFileSync(path.join(judgeDir, "product.hidden.test.js"), "utf8");

  await writeHiddenTests(locator, {
    "product.hidden.test.js": hiddenTestJs,
  });
  await writeHiddenTests(workspaceLocator, {
    "product.hidden.test.js": hiddenTestJs,
  });
  console.log(`  ✓ Wrote hidden tests to MinIO storage for both assignments`);

  console.log("\n🎉 All assignments successfully allocated to Course 1!");
}

seedAssignments()
  .catch((err) => {
    console.error("❌ Seed error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
