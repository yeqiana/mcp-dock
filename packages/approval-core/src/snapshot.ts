import { createHash } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { assertPathInside } from "@mcp-dock/core";

export interface ApprovalRoot {
  id: string;
  name: string;
  path: string;
}

export type CleanupCategory =
  | "build-output"
  | "build-cache"
  | "dependency-installation"
  | "package-cache"
  | "python-environment"
  | "python-bytecode"
  | "test-cache"
  | "test-output";

const CANDIDATES = new Map<string, CleanupCategory>([
  ["dist", "build-output"], ["build", "build-output"], ["target", "build-output"],
  [".next", "build-cache"], [".nuxt", "build-cache"], [".turbo", "build-cache"],
  [".gradle", "build-cache"], ["coverage", "test-output"],
  [".pytest_cache", "test-cache"], [".mypy_cache", "test-cache"],
  [".ruff_cache", "test-cache"], ["__pycache__", "python-bytecode"],
  ["node_modules", "dependency-installation"], [".pnpm-store", "package-cache"],
  [".npm", "package-cache"], [".venv", "python-environment"], ["venv", "python-environment"],
]);

const FORBIDDEN = new Set([
  ".git", ".svn", ".hg", ".ssh", ".aws", ".kube", ".azure",
  ".gnupg", ".docker", ".local", "secrets", "credentials", "$recycle.bin",
  "system volume information", ".git-credentials", ".npmrc", ".netrc",
]);
const SECRET_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".kdbx"]);
const MAX_ENTRIES = 10000;
const MAX_DEPTH = 16;

function rejectSensitive(name: string): void {
  const lower = name.toLowerCase();
  if (
    FORBIDDEN.has(lower) || lower === ".env" || lower.startsWith(".env.") ||
    lower === ".envrc" || lower.startsWith(".envrc.") ||
    lower === "id_rsa" || lower.startsWith("id_rsa.") ||
    lower === "id_ed25519" || lower.startsWith("id_ed25519.") ||
    lower === "id_ecdsa" || lower.startsWith("id_ecdsa.") ||
    SECRET_EXTENSIONS.has(path.extname(lower)) || lower.endsWith(".secret")
  ) throw new Error("sensitive_cleanup_target_denied");
}

export interface ResourceSnapshot {
  rootId: string;
  relativePath: string;
  category: CleanupCategory;
  versionDigest: string;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  scannedEntries: number;
}

export async function snapshotCleanupDirectory(
  roots: ReadonlyMap<string, ApprovalRoot>,
  rootId: string,
  relativePath: string,
): Promise<ResourceSnapshot> {
  const root = roots.get(rootId);
  if (!root) throw new Error("unknown_approval_root");
  if (!relativePath || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) ||
      relativePath.includes("\0")) {
    throw new Error("relative_cleanup_path_required");
  }
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.some((part) => part === ".." || part.includes(":"))) {
    throw new Error("unsafe_cleanup_path");
  }
  for (const segment of segments) rejectSensitive(segment);
  const category = CANDIDATES.get(segments[segments.length - 1]!.toLowerCase());
  if (!category) throw new Error("not_a_supported_cleanup_candidate");

  const resolvedRoot = await realpath(root.path);
  const baseInfo = await lstat(resolvedRoot);
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) throw new Error("invalid_cleanup_root");
  const target = assertPathInside(resolvedRoot, path.resolve(resolvedRoot, ...segments));

  // Reject junctions and symlinks in every ancestor, not just at the final path.
  let current = resolvedRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("cleanup_symlink_denied");
  }
  const actual = await realpath(target);
  assertPathInside(resolvedRoot, actual);
  const targetInfo = await lstat(actual);
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
    throw new Error("cleanup_target_must_be_directory");
  }

  const hash = createHash("sha256");
  hash.update("mcp-dock-cleanup-snapshot-v1\n");
  let scannedEntries = 0;
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;

  async function visit(absolute: string, relative: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) throw new Error("cleanup_snapshot_depth_limit");
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error("cleanup_symlink_denied");
    if (!info.isDirectory()) throw new Error("cleanup_directory_changed_during_scan");
    directoryCount += 1;
    hash.update(JSON.stringify(["dir", relative, info.mtimeMs, info.ctimeMs, info.mode, info.ino]) + "\n");
    const dir = await opendir(absolute);
    const entries: Array<{ name: string; directory: boolean; file: boolean; symlink: boolean }> = [];
    for await (const item of dir) {
      scannedEntries += 1;
      if (scannedEntries > MAX_ENTRIES) throw new Error("cleanup_snapshot_entry_limit");
      entries.push({
        name: item.name,
        directory: item.isDirectory(),
        file: item.isFile(),
        symlink: item.isSymbolicLink(),
      });
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      rejectSensitive(entry.name);
      if (entry.symlink) throw new Error("cleanup_symlink_denied");
      const child = path.join(absolute, entry.name);
      const childRelative = relative ? relative + "/" + entry.name : entry.name;
      if (entry.directory) {
        await visit(child, childRelative, depth + 1);
      } else if (entry.file) {
        const file = await lstat(child);
        if (file.isSymbolicLink() || !file.isFile()) throw new Error("cleanup_file_changed_during_scan");
        fileCount += 1;
        totalBytes += file.size;
        hash.update(JSON.stringify(["file", childRelative, file.size, file.mtimeMs, file.ctimeMs, file.mode, file.ino]) + "\n");
      } else {
        throw new Error("unsupported_cleanup_filesystem_entry");
      }
    }
  }

  await visit(actual, "", 0);
  return {
    rootId,
    relativePath: path.relative(resolvedRoot, actual).replaceAll("\\", "/"),
    category,
    versionDigest: hash.digest("hex"),
    fileCount,
    directoryCount,
    totalBytes,
    scannedEntries,
  };
}
