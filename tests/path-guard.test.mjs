import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { isPathInside } from "../packages/core/dist/path-guard.js";

const root = path.resolve("sandbox-root");

test("accepts the root itself", () => {
  assert.equal(isPathInside(root, root), true);
});

test("accepts descendants", () => {
  assert.equal(isPathInside(root, path.join(root, "apps", "local-dev-mcp")), true);
});

test("rejects sibling directories", () => {
  assert.equal(isPathInside(root, path.resolve(root, "..", "sandbox-root-escape")), false);
});

test("rejects parent directories", () => {
  assert.equal(isPathInside(root, path.dirname(root)), false);
});
