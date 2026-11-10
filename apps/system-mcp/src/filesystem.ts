import { lstat, opendir, realpath, stat, open } from "node:fs/promises";
import path from "node:path";
import { assertPathInside } from "@mcp-dock/core";
import type { SystemConfig, SystemRoot } from "./config.js";

const HARD_EXCLUDED_DIRS = new Set([
  ".git", ".svn", ".hg", "$recycle.bin", "system volume information",
]);

const GENERATED_DIRS = new Set([
  "node_modules", "dist", "build", "target", ".gradle", ".idea", ".next",
  "coverage", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
  ".ruff_cache", ".turbo", ".nuxt", "vendor", "bower_components",
  ".pnpm-store", ".npm", ".cache",
]);

const CLEANUP_CANDIDATES = new Map<string, string>([
  ["dist", "build-output"],
  ["build", "build-output"],
  ["target", "build-output"],
  [".next", "build-cache"],
  [".nuxt", "build-cache"],
  [".turbo", "build-cache"],
  [".gradle", "build-cache"],
  ["coverage", "test-output"],
  [".pytest_cache", "test-cache"],
  [".mypy_cache", "test-cache"],
  [".ruff_cache", "test-cache"],
  ["__pycache__", "python-bytecode"],
  ["node_modules", "dependency-installation"],
  [".pnpm-store", "package-cache"],
  [".npm", "package-cache"],
  [".venv", "python-environment"],
  ["venv", "python-environment"],
]);

const SENSITIVE_DIRS = new Set([
  ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".local",
  "secrets", "credentials",
]);

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonc", ".yaml", ".yml", ".toml",
  ".xml", ".html", ".htm", ".css", ".scss", ".less", ".vue", ".svelte",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".kt",
  ".go", ".rs", ".c", ".h", ".cpp", ".cs", ".sql", ".sh", ".ps1",
  ".bat", ".cmd", ".properties", ".ini", ".conf", ".gradle", ".lock",
  ".csv", ".log", ".gitignore",
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".kdbx",
]);

function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  const extension = path.extname(lower);
  return (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower === ".envrc" ||
    lower.startsWith(".envrc.") ||
    lower === ".npmrc" ||
    lower === ".pypirc" ||
    lower === ".netrc" ||
    lower === ".git-credentials" ||
    lower === "netrc" ||
    lower === "credentials" ||
    lower.startsWith("credentials.") ||
    lower === "id_rsa" ||
    lower.startsWith("id_rsa.") ||
    lower === "id_ed25519" ||
    lower.startsWith("id_ed25519.") ||
    lower === "id_ecdsa" ||
    lower.startsWith("id_ecdsa.") ||
    SENSITIVE_DIRS.has(lower) ||
    SENSITIVE_EXTENSIONS.has(extension) ||
    lower.endsWith(".secret")
  );
}

function isSkippedDirectory(name: string, includeGenerated: boolean): boolean {
  const lower = name.toLowerCase();
  return HARD_EXCLUDED_DIRS.has(lower) ||
    SENSITIVE_DIRS.has(lower) ||
    (!includeGenerated && GENERATED_DIRS.has(lower));
}

function getRoot(config: SystemConfig, rootId: string): SystemRoot {
  const root = config.roots.get(rootId);
  if (!root) throw new Error("unknown_system_root_id: " + rootId);
  return root;
}

async function resolveSafePath(root: SystemRoot, relativePath: string) {
  if (relativePath.includes("\0") || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error("relative_path_required");
  }

  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => segment === ".." || segment.includes(":"))) {
    throw new Error("path_traversal_rejected");
  }
  if (segments.some(isSensitiveName)) {
    throw new Error("sensitive_path_access_denied");
  }

  const target = segments.length > 0
    ? path.resolve(root.path, ...segments)
    : root.path;
  const safeTarget = assertPathInside(root.path, target);
  let cursor = root.path;

  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) {
      throw new Error("symbolic_link_access_denied");
    }
  }

  const resolved = await realpath(safeTarget);
  assertPathInside(root.path, resolved);
  return { absolutePath: resolved, relativePath: path.relative(root.path, resolved) || "." };
}

function isIgnorableFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR";
}

export async function listDirectory(
  config: SystemConfig,
  rootId: string,
  relativePath: string,
  limit: number,
) {
  const root = getRoot(config, rootId);
  const target = await resolveSafePath(root, relativePath);
  const info = await stat(target.absolutePath);
  if (!info.isDirectory()) throw new Error("target_is_not_a_directory");

  const visible: Array<{ name: string; isDirectory: boolean }> = [];
  let scannedEntries = 0;
  let scanTruncated = false;
  const directory = await opendir(target.absolutePath);
  const scanBudget = Math.min(2000, Math.max(1000, limit * 10));

  for await (const entry of directory) {
    if (scannedEntries >= scanBudget) {
      scanTruncated = true;
      break;
    }
    scannedEntries += 1;
    if (
      entry.isSymbolicLink() ||
      isSensitiveName(entry.name) ||
      HARD_EXCLUDED_DIRS.has(entry.name.toLowerCase())
    ) {
      continue;
    }
    visible.push({ name: entry.name, isDirectory: entry.isDirectory() });
  }

  visible.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const selected = visible.slice(0, limit);
  const items = await Promise.all(selected.map(async (entry) => {
    const entryPath = path.join(target.absolutePath, entry.name);
    try {
      const entryInfo = await lstat(entryPath);
      if (entryInfo.isSymbolicLink()) return null;
      return {
        name: entry.name,
        relativePath: path.relative(root.path, entryPath),
        type: entryInfo.isDirectory() ? "directory" : entryInfo.isFile() ? "file" : "other",
        sizeBytes: entryInfo.isFile() ? entryInfo.size : null,
        modifiedAt: entryInfo.mtime.toISOString(),
      };
    } catch (error) {
      if (isIgnorableFsError(error)) return null;
      throw error;
    }
  }));

  return {
    rootId,
    directory: target.relativePath,
    returnedEntries: items.filter(Boolean).length,
    totalVisibleEntries: scanTruncated ? null : visible.length,
    scannedEntries,
    truncated: scanTruncated || visible.length > limit,
    entries: items.filter((item): item is NonNullable<typeof item> => item !== null),
  };
}

export async function searchFiles(
  config: SystemConfig,
  rootId: string,
  query: string,
  limit: number,
  maxDepth: number,
  includeGenerated: boolean,
) {
  const root = getRoot(config, rootId);
  const needle = query.toLocaleLowerCase();
  const stack: Array<{ absolutePath: string; relativePath: string; depth: number }> = [
    { absolutePath: root.path, relativePath: "", depth: 0 },
  ];
  const matches: Array<{ name: string; relativePath: string; sizeBytes: number; modifiedAt: string }> = [];
  let scannedEntries = 0;
  let truncated = false;
  let depthLimited = false;

  while (stack.length > 0 && matches.length < limit) {
    const current = stack.pop()!;
    let directory;
    try {
      directory = await opendir(current.absolutePath);
    } catch (error) {
      if (isIgnorableFsError(error)) continue;
      throw error;
    }

    for await (const entry of directory) {
      scannedEntries += 1;
      if (scannedEntries > config.limits.maxScanEntries) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink() || isSensitiveName(entry.name)) continue;

      const relative = current.relativePath
        ? path.join(current.relativePath, entry.name)
        : entry.name;

      if (entry.isDirectory()) {
        if (isSkippedDirectory(entry.name, includeGenerated)) continue;
        if (current.depth >= maxDepth) {
          depthLimited = true;
          continue;
        }
        stack.push({
          absolutePath: path.join(current.absolutePath, entry.name),
          relativePath: relative,
          depth: current.depth + 1,
        });
        continue;
      }
      if (!entry.isFile() || !entry.name.toLocaleLowerCase().includes(needle)) continue;
      try {
        const fileInfo = await lstat(path.join(current.absolutePath, entry.name));
        if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) continue;
        matches.push({
          name: entry.name,
          relativePath: relative,
          sizeBytes: fileInfo.size,
          modifiedAt: fileInfo.mtime.toISOString(),
        });
        if (matches.length >= limit) break;
      } catch (error) {
        if (!isIgnorableFsError(error)) throw error;
      }
    }
    if (truncated) break;
  }

  return {
    rootId,
    query,
    returnedFiles: matches.length,
    scannedEntries,
    truncated: truncated || depthLimited || matches.length >= limit,
    includeGenerated,
    files: matches,
  };
}

export async function scanLargeFiles(
  config: SystemConfig,
  rootId: string,
  minBytes: number,
  limit: number,
  maxDepth: number,
  maxEntries: number,
  includeGenerated: boolean,
) {
  const root = getRoot(config, rootId);
  const entryBudget = Math.min(maxEntries, config.limits.maxScanEntries);
  const stack: Array<{ absolutePath: string; relativePath: string; depth: number }> = [
    { absolutePath: root.path, relativePath: "", depth: 0 },
  ];
  const matches: Array<{ name: string; relativePath: string; sizeBytes: number; modifiedAt: string }> = [];
  let scannedEntries = 0;
  let truncated = false;
  let depthLimited = false;

  while (stack.length > 0) {
    const current = stack.pop()!;
    let directory;
    try {
      directory = await opendir(current.absolutePath);
    } catch (error) {
      if (isIgnorableFsError(error)) continue;
      throw error;
    }

    for await (const entry of directory) {
      scannedEntries += 1;
      if (scannedEntries > entryBudget) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink() || isSensitiveName(entry.name)) continue;

      const relative = current.relativePath
        ? path.join(current.relativePath, entry.name)
        : entry.name;

      if (entry.isDirectory()) {
        if (isSkippedDirectory(entry.name, includeGenerated)) continue;
        if (current.depth >= maxDepth) {
          depthLimited = true;
          continue;
        }
        stack.push({
          absolutePath: path.join(current.absolutePath, entry.name),
          relativePath: relative,
          depth: current.depth + 1,
        });
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const fileInfo = await lstat(path.join(current.absolutePath, entry.name));
        if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.size < minBytes) continue;
        matches.push({
          name: entry.name,
          relativePath: relative,
          sizeBytes: fileInfo.size,
          modifiedAt: fileInfo.mtime.toISOString(),
        });
      } catch (error) {
        if (!isIgnorableFsError(error)) throw error;
      }
    }
    if (truncated) break;
  }

  matches.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return {
    rootId,
    minBytes,
    returnedFiles: Math.min(matches.length, limit),
    scannedEntries,
    entryBudget,
    truncated: truncated || depthLimited,
    includeGenerated,
    files: matches.slice(0, limit),
  };
}

export async function analyzeDirectory(
  config: SystemConfig,
  rootId: string,
  relativePath: string,
  maxDepth: number,
  maxEntries: number,
  includeGenerated: boolean,
) {
  const root = getRoot(config, rootId);
  const target = await resolveSafePath(root, relativePath);
  const rootInfo = await stat(target.absolutePath);
  if (!rootInfo.isDirectory()) throw new Error("target_is_not_a_directory");

  const entryBudget = Math.min(maxEntries, config.limits.maxScanEntries);
  const stack: Array<{ absolutePath: string; relativePath: string; depth: number }> = [
    { absolutePath: target.absolutePath, relativePath: target.relativePath, depth: 0 },
  ];
  const largestFiles: Array<{ relativePath: string; sizeBytes: number }> = [];
  let totalBytes = 0;
  let fileCount = 0;
  let directoryCount = 1;
  let scannedEntries = 0;
  let skippedDirectories = 0;
  let truncated = false;
  let depthLimited = false;

  while (stack.length > 0) {
    const current = stack.pop()!;
    let directory;
    try {
      directory = await opendir(current.absolutePath);
    } catch (error) {
      if (isIgnorableFsError(error)) continue;
      throw error;
    }

    for await (const entry of directory) {
      scannedEntries += 1;
      if (scannedEntries > entryBudget) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink() || isSensitiveName(entry.name)) continue;

      const relative = path.join(current.relativePath, entry.name);
      if (entry.isDirectory()) {
        if (isSkippedDirectory(entry.name, includeGenerated)) {
          skippedDirectories += 1;
          continue;
        }
        if (current.depth >= maxDepth) {
          depthLimited = true;
          continue;
        }
        directoryCount += 1;
        stack.push({
          absolutePath: path.join(current.absolutePath, entry.name),
          relativePath: relative,
          depth: current.depth + 1,
        });
        continue;
      }

      if (!entry.isFile()) continue;
      try {
        const fileInfo = await lstat(path.join(current.absolutePath, entry.name));
        if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) continue;
        totalBytes += fileInfo.size;
        fileCount += 1;
        largestFiles.push({ relativePath: relative, sizeBytes: fileInfo.size });
        largestFiles.sort((a, b) => b.sizeBytes - a.sizeBytes);
        if (largestFiles.length > 20) largestFiles.pop();
      } catch (error) {
        if (!isIgnorableFsError(error)) throw error;
      }
    }
    if (truncated) break;
  }

  return {
    rootId,
    directory: target.relativePath,
    measuredBytes: totalBytes,
    fileCount,
    directoryCount,
    skippedDirectories,
    scannedEntries,
    entryBudget,
    maxDepth,
    includeGenerated,
    truncated: truncated || depthLimited,
    complete: !truncated && !depthLimited,
    largestFiles,
  };
}

export async function planCleanup(
  config: SystemConfig,
  rootId: string,
  relativePath: string,
  maxDepth: number,
  maxEntries: number,
  maxCandidates: number,
) {
  const root = getRoot(config, rootId);
  const target = await resolveSafePath(root, relativePath);
  const rootInfo = await stat(target.absolutePath);
  if (!rootInfo.isDirectory()) throw new Error("target_is_not_a_directory");

  type Candidate = {
    name: string;
    relativePath: string;
    category: string;
    estimatedBytes: number;
    fileCount: number;
    lastModifiedAt: string | null;
    complete: boolean;
  };

  const candidates: Candidate[] = [];
  const rootName = path.basename(target.absolutePath).toLowerCase();
  const rootCategory = CLEANUP_CANDIDATES.get(rootName);
  let rootCandidateIndex: number | null = null;
  if (rootCategory) {
    rootCandidateIndex = 0;
    candidates.push({
      name: path.basename(target.absolutePath),
      relativePath: target.relativePath,
      category: rootCategory,
      estimatedBytes: 0,
      fileCount: 0,
      lastModifiedAt: null,
      complete: true,
    });
  }

  const entryBudget = Math.min(maxEntries, config.limits.maxScanEntries);
  const stack: Array<{ absolutePath: string; relativePath: string; depth: number; candidateIndex: number | null }> = [
    {
      absolutePath: target.absolutePath,
      relativePath: target.relativePath,
      depth: 0,
      candidateIndex: rootCandidateIndex,
    },
  ];
  let scannedEntries = 0;
  let truncated = false;
  let depthLimited = false;
  let candidateLimitReached = false;

  while (stack.length > 0) {
    const current = stack.pop()!;
    let directory;
    try {
      directory = await opendir(current.absolutePath);
    } catch (error) {
      if (isIgnorableFsError(error)) continue;
      throw error;
    }

    for await (const entry of directory) {
      scannedEntries += 1;
      if (scannedEntries > entryBudget) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink() || isSensitiveName(entry.name)) continue;

      const relative = path.join(current.relativePath, entry.name);
      if (entry.isDirectory()) {
        const lowerName = entry.name.toLowerCase();
        if (HARD_EXCLUDED_DIRS.has(lowerName) || SENSITIVE_DIRS.has(lowerName)) continue;

        let candidateIndex = current.candidateIndex;
        if (candidateIndex === null) {
          const category = CLEANUP_CANDIDATES.get(lowerName);
          if (category) {
            if (candidates.length >= maxCandidates) {
              candidateLimitReached = true;
              continue;
            }
            candidateIndex = candidates.length;
            candidates.push({
              name: entry.name,
              relativePath: relative,
              category,
              estimatedBytes: 0,
              fileCount: 0,
              lastModifiedAt: null,
              complete: true,
            });
          }
        }

        if (current.depth >= maxDepth) {
          depthLimited = true;
          if (candidateIndex !== null) candidates[candidateIndex]!.complete = false;
          continue;
        }

        stack.push({
          absolutePath: path.join(current.absolutePath, entry.name),
          relativePath: relative,
          depth: current.depth + 1,
          candidateIndex,
        });
        continue;
      }

      if (!entry.isFile() || current.candidateIndex === null) continue;
      try {
        const fileInfo = await lstat(path.join(current.absolutePath, entry.name));
        if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) continue;
        const candidate = candidates[current.candidateIndex]!;
        candidate.estimatedBytes += fileInfo.size;
        candidate.fileCount += 1;
        if (!candidate.lastModifiedAt || fileInfo.mtime > new Date(candidate.lastModifiedAt)) {
          candidate.lastModifiedAt = fileInfo.mtime.toISOString();
        }
      } catch (error) {
        if (!isIgnorableFsError(error)) throw error;
      }
    }

    if (truncated) break;
  }

  if (truncated) {
    for (const candidate of candidates) candidate.complete = false;
  }

  candidates.sort((a, b) => b.estimatedBytes - a.estimatedBytes);
  return {
    rootId,
    directory: target.relativePath,
    scannedEntries,
    entryBudget,
    maxDepth,
    candidateCount: candidates.length,
    totalEstimatedBytes: candidates.reduce((total, candidate) => total + candidate.estimatedBytes, 0),
    truncated: truncated || depthLimited || candidateLimitReached,
    complete: !truncated && !depthLimited && !candidateLimitReached,
    deletionPerformed: false,
    manualReviewRequired: true,
    candidates,
  };
}

export async function getFileMetadata(
  config: SystemConfig,
  rootId: string,
  relativePath: string,
) {
  const root = getRoot(config, rootId);
  const target = await resolveSafePath(root, relativePath);
  const info = await lstat(target.absolutePath);
  if (info.isSymbolicLink()) throw new Error("symbolic_link_access_denied");
  if (!info.isFile()) throw new Error("target_is_not_a_regular_file");

  return {
    rootId,
    name: path.basename(target.absolutePath),
    relativePath: target.relativePath,
    extension: path.extname(target.absolutePath).toLowerCase(),
    sizeBytes: info.size,
    createdAt: info.birthtime.toISOString(),
    modifiedAt: info.mtime.toISOString(),
    accessedAt: info.atime.toISOString(),
  };
}

function redactSecrets(value: string): string {
  return value
    .replace(
      /("(?:authorization|token|access_token|refresh_token|password|secret|api_key|client_secret)"\s*:\s*")[^"]+(")/gi,
      "$1[REDACTED]$2",
    )
    .replace(
      /(authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,;"']+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}\b/gi, "Bearer [REDACTED]")    .replace(
      /((?:api[_-]?key|access[_-]?(?:token|key)|refresh[_-]?token|token|password|secret|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[PRIVATE KEY REDACTED]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      "[REDACTED]",
    );
}
export async function readTextFile(
  config: SystemConfig,
  rootId: string,
  relativePath: string,
  maxBytes: number,
) {
  const root = getRoot(config, rootId);
  const target = await resolveSafePath(root, relativePath);
  const extension = path.extname(target.absolutePath).toLowerCase();
  const baseName = path.basename(target.absolutePath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension) && ![".gitignore", ".editorconfig", "dockerfile", "makefile", "license"].includes(baseName)) {
    throw new Error("file_extension_not_allowed_for_text_read");
  }

  const maxAllowed = Math.min(maxBytes, config.limits.maxReadBytes);
  const handle = await open(target.absolutePath, "r");
  try {
    const fileInfo = await handle.stat();
    if (!fileInfo.isFile()) throw new Error("target_is_not_a_regular_file");
    if (fileInfo.size > maxAllowed) throw new Error("file_exceeds_read_limit");

    const buffer = Buffer.alloc(maxAllowed + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxAllowed) throw new Error("file_exceeds_read_limit");
    const content = buffer.subarray(0, bytesRead);
    if (content.includes(0)) throw new Error("binary_file_read_rejected");

    const text = content.toString("utf8");
    const redacted = redactSecrets(text);
    return {
      rootId,
      relativePath: target.relativePath,
      sizeBytes: content.byteLength,
      redactionApplied: redacted !== text,
      content: redacted,
    };
  } finally {
    await handle.close();
  }
}