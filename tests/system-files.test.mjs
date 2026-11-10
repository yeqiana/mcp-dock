import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeDirectory,
  getFileMetadata,
  listDirectory,
  planCleanup,
  readTextFile,
  scanLargeFiles,
  searchFiles,
} from "../apps/system-mcp/dist/filesystem.js";

const temporaryRoots = [];

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-dock-system-test-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "hidden-package"), { recursive: true });
  const apiKeyFixture = ["fixture", "secret", "value"].join("-");
  const bearerFixture = ["abcdefghijkl", "mnop"].join("");
  await writeFile(
    path.join(root, "src", "README.md"),
    "# fixture\napi_key = \"" + apiKeyFixture + "\"\nAuthorization: Bearer " + bearerFixture + "\n",
  );
  await writeFile(path.join(root, "src", "large.bin.txt"), "x".repeat(4096));  await writeFile(path.join(root, ".env"), "TOKEN=do-not-read");
  const credentialsFixture = ["https://", "user", ":", "secret", "@", "example.invalid"].join("");
  await writeFile(path.join(root, ".git-credentials"), credentialsFixture);  await writeFile(path.join(root, "node_modules", "hidden-package", "README.md"), "hidden");
  return {
    root,
    config: {
      roots: new Map([["workspace", { id: "workspace", name: "Fixture", path: root }]]),
      limits: { maxScanEntries: 10000, maxDepth: 8, maxReadBytes: 65536 },
    },
  };
}

test.after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("searchFiles finds names and excludes generated and sensitive paths by default", async () => {
  const { config } = await createFixture();
  const result = await searchFiles(config, "workspace", "README.md", 20, 8, false);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]?.relativePath, path.join("src", "README.md"));
});

test("readTextFile is bounded and redacts common credential patterns", async () => {
  const { config } = await createFixture();
  const result = await readTextFile(config, "workspace", path.join("src", "README.md"), 65536);
  assert.match(result.content, /# fixture/);
  assert.match(result.content, /api_key = \[REDACTED\]/);
  assert.equal(result.redactionApplied, true);
  assert.equal(result.content.includes("fixture-secret-value"), false);
  assert.equal(result.content.includes("abcdefghijklmnop"), false);
  await assert.rejects(
    readTextFile(config, "workspace", path.join("src", "large.bin.txt"), 1024),
    /file_exceeds_read_limit/,
  );
  await assert.rejects(
    readTextFile(config, "workspace", ".git-credentials", 65536),
    /sensitive_path_access_denied/,
  );
  await assert.rejects(
    readTextFile(config, "workspace", ".env", 65536),
    /sensitive_path_access_denied/,
  );
});

test("path traversal is rejected before file access", async () => {
  const { config } = await createFixture();
  await assert.rejects(
    getFileMetadata(config, "workspace", "../outside.txt"),
    /path_traversal_rejected/,
  );
});

test("rejects symlink traversal", async (t) => {
  const { root, config } = await createFixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "mcp-dock-system-outside-"));
  temporaryRoots.push(outside);
  await writeFile(path.join(outside, "outside.txt"), "outside");
  try {
    await symlink(outside, path.join(root, "external-link"), "junction");
  } catch {
    t.skip("Windows junction creation is unavailable in this environment");
    return;
  }
  await assert.rejects(
    getFileMetadata(config, "workspace", path.join("external-link", "outside.txt")),
    /symbolic_link_access_denied/,
  );
});
test("planCleanup reports generated directories without deleting anything", async () => {
  const { config } = await createFixture();
  const result = await planCleanup(config, "workspace", ".", 8, 10000, 10);
  assert.equal(result.deletionPerformed, false);
  assert.equal(result.manualReviewRequired, true);
  assert.equal(result.complete, true);
  assert.equal(result.candidates[0]?.name, "node_modules");
  assert.ok(result.totalEstimatedBytes > 0);
});

test("analyzeDirectory reports bounded directory totals and largest files", async () => {
  const { config } = await createFixture();
  const result = await analyzeDirectory(config, "workspace", "src", 8, 10000, false);
  assert.equal(result.complete, true);
  assert.equal(result.fileCount, 2);
  assert.ok(result.measuredBytes >= 4096);
  assert.equal(result.largestFiles[0]?.relativePath, path.join("src", "large.bin.txt"));
});
test("scanLargeFiles returns files above the requested threshold in descending order", async () => {
  const { config } = await createFixture();
  const result = await scanLargeFiles(config, "workspace", 1024, 10, 8, 10000, false);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]?.name, "large.bin.txt");
  assert.ok(result.files[0]?.sizeBytes >= 4096);
});

test("listDirectory omits sensitive entries", async () => {
  const { config } = await createFixture();
  const result = await listDirectory(config, "workspace", ".", 100);
  const names = result.entries.map((entry) => entry.name);
  assert.equal(names.includes(".env"), false);
  assert.equal(names.includes(".git"), false);
  assert.equal(names.includes("src"), true);
});
