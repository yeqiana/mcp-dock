import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const maxFileBytes = 2 * 1024 * 1024;
const skippedExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip",
  ".gz", ".7z", ".exe", ".dll", ".woff", ".woff2", ".ttf", ".mp4", ".mp3",
]);

const rules = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["url-credentials", /https?:\/\/([^/\s:@]+:[^/\s@]+)@/i],
  ["known-token", /\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{30,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-(?:proj|svcacct|live|ant)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,})\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["bearer-token", /\bBearer\s+([A-Za-z0-9._~-]{16,})/i],
  ["database-credentials", /\b(?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis):\/\/([^/\s:@]+:[^/\s@]+)@/i],
  ["credential-assignment", /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9_]*(?:password|passwd|secret(?:[_-]?key)?|token|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token)|authorization|bearer|cookie|private[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9_./+=:-]{12,})/i],
  ["local-user-path", /\b[A-Z]:[\\/]+Users[\\/]+(?!Public[\\/]|Default[\\/]|All Users[\\/])[^\\/\s"'<>]+/i],
  ["local-machine-path", /\b[A-Z]:[\\/]+(?:workspace|workspaces|soft)[\\/]+[^"'<> \r\n]+/i],
  ["private-network-address", /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
  ["local-runner-binding", /\bwc_(?:client|runner|endpoint)_[A-Za-z0-9_-]{16,}\b/],
];

const sensitiveFileName = /(?:^|\/)(?:\.env(?:\.(?!example$)[^/]*)?|[^/]+\.env|\.git-credentials|\.netrc|\.npmrc|\.pypirc|secret\.key|secrets?\.(?:json|ya?ml)|credentials?\.(?:json|ya?ml)|token\.(?:json|ya?ml)|service-account[^/]*\.json|id_rsa|id_ed25519|[^/]+\.(?:pem|key|p12|pfx|jks|keystore|sqlite3?|db|dump))$/i;
const placeholder = /(?:example|sample|placeholder|change[-_]?me|replace[-_]?me|your[-_]|path\/to|<[^>]+>|\$\{|\{\{|\*{4,}|redacted)/i;

let candidatePaths;
try {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  candidatePaths = [...new Set(output.split("\0").filter(Boolean))];
} catch {
  console.error("安全扫描失败：无法取得 Git 交付文件清单。请在 Git 仓库根目录运行。");
  process.exit(2);
}

const findings = [];
const findingKeys = new Set();

function addFinding(relativePath, line, rule) {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  const key = normalizedPath + ":" + line + ":" + rule;
  if (findingKeys.has(key)) return;
  findingKeys.add(key);
  findings.push({ path: normalizedPath, line, rule });
}

function inspectPathName(relativePath) {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  if (sensitiveFileName.test(normalizedPath) && !normalizedPath.endsWith(".env.example")) {
    addFinding(normalizedPath, 1, "sensitive-file-name");
    return false;
  }
  return true;
}

function inspectContent(relativePath, content) {
  if (content.includes("\0")) return;
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const [rule, pattern] of rules) {
      const match = line.match(pattern);
      if (!match) continue;
      if (placeholder.test(match[1] ?? match[0])) continue;
      if (rule === "private-network-address" && /\b(?:127\.0\.0\.1|0\.0\.0\.0)\b/.test(match[0])) continue;
      addFinding(relativePath, index + 1, rule);
    }
  }
}

for (const relativePath of candidatePaths) {
  if (!inspectPathName(relativePath)) continue;
  if (skippedExtensions.has(path.extname(relativePath).toLowerCase())) continue;

  let fileStat;
  try {
    fileStat = await stat(path.join(root, relativePath));
  } catch {
    continue;
  }
  if (!fileStat.isFile()) continue;
  if (fileStat.size > maxFileBytes) {
    addFinding(relativePath, 1, "oversized-file-unscanned");
    continue;
  }

  try {
    const content = await readFile(path.join(root, relativePath), "utf8");
    inspectContent(relativePath, content);
  } catch {
    addFinding(relativePath, 1, "file-unreadable");
  }
}

// Also inspect the exact Git index blobs: a staged secret must be caught even
// when the working-tree copy has already been sanitized.
let indexEntries;
try {
  const output = execFileSync(
    "git",
    ["ls-files", "--stage", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  indexEntries = output.split("\0").filter(Boolean);
} catch {
  console.error("安全扫描失败：无法读取 Git 暂存区。");
  process.exit(2);
}

for (const entry of indexEntries) {
  const separator = entry.indexOf("\t");
  if (separator < 0) continue;
  const metadata = entry.slice(0, separator).split(" ");
  const stage = metadata[2];
  const relativePath = entry.slice(separator + 1);

  if (stage !== "0") {
    addFinding(relativePath, 1, "unmerged-index-entry");
    continue;
  }
  if (!inspectPathName(relativePath)) continue;
  if (skippedExtensions.has(path.extname(relativePath).toLowerCase())) continue;

  try {
    const content = execFileSync(
      "git",
      ["show", ":" + relativePath],
      { cwd: root, encoding: "utf8", maxBuffer: maxFileBytes + 1 },
    );
    if (Buffer.byteLength(content, "utf8") > maxFileBytes) {
      addFinding(relativePath, 1, "oversized-index-blob-unscanned");
      continue;
    }
    inspectContent(relativePath, content);
  } catch {
    addFinding(relativePath, 1, "index-blob-unreadable");
  }
}
if (findings.length > 0) {
  console.error("安全扫描未通过：发现 " + findings.length + " 个交付风险点。仅显示位置和风险类别，不回显内容：");
  for (const finding of findings.sort((a, b) =>
    a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule)
  )) {
    console.error(finding.path + ":" + finding.line + ":" + finding.rule);
  }
  process.exit(1);
}

console.log("安全扫描通过：已检查 " + candidatePaths.length + " 个 Git 交付候选文件，未发现已知凭据、私钥、本机路径或敏感文件。");
