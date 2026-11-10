import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { assertPathInside } from "./path-guard.js";
import { runExecutable } from "./process.js";

const RunnerConfigSchema = z.object({
  version: z.literal(1),
  runner: z.object({
    serverUrl: z.string().url(),
    healthPath: z.string().regex(/^\/[A-Za-z0-9/_-]*$/),
    logsDir: z.string().min(1),
    serverProcessName: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    runnerProcessName: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  }).strict(),
}).strict();

export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

export async function loadRunnerConfig(
  configPath = process.env.MCP_DOCK_SYSTEM_CONFIG ??
    path.resolve(process.cwd(), "config/system.yaml"),
): Promise<RunnerConfig> {
  const content = await readFile(path.resolve(configPath), "utf8");
  const config = RunnerConfigSchema.parse(parse(content));

  const serverUrl = new URL(config.runner.serverUrl);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!["http:", "https:"].includes(serverUrl.protocol) || !loopbackHosts.has(serverUrl.hostname.toLowerCase())) {
    throw new Error("runner_server_url_must_be_loopback_http");
  }
  if (serverUrl.username || serverUrl.password) {
    throw new Error("runner_server_url_must_not_contain_credentials");
  }
  if (!path.isAbsolute(config.runner.logsDir)) {
    throw new Error("runner_logs_dir_must_be_absolute");
  }

  return config;
}

interface ProcessEntry {
  imageName: string;
  processId: number;
}

async function listProcesses(imageName: string): Promise<ProcessEntry[]> {
  if (process.platform !== "win32") {
    throw new Error("webcodex_runner_process_inspection_requires_windows");
  }

  const { stdout } = await runExecutable(
    "tasklist.exe",
    ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"],
    { cwd: process.cwd(), timeoutMs: 5_000, maxBufferBytes: 128 * 1024 },
  );

  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^"([^"]+)","(\d+)"/);
    if (!match) return [];
    return [{ imageName: match[1]!, processId: Number(match[2]) }];
  });
}

export async function getRunnerStatus(config: RunnerConfig) {
  const runner = config.runner;
  const [serverProcesses, runnerProcesses, health] = await Promise.all([
    listProcesses(runner.serverProcessName),
    listProcesses(runner.runnerProcessName),
    (async () => {
      try {
        const base = runner.serverUrl.endsWith("/")
          ? runner.serverUrl
          : `${runner.serverUrl}/`;
        const url = new URL(runner.healthPath.replace(/^\//, ""), base);
        const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
        return { reachable: response.ok, statusCode: response.status };
      } catch {
        return { reachable: false, statusCode: null };
      }
    })(),
  ]);

  return {
    observedAt: new Date().toISOString(),
    platform: process.platform,
    server: {
      processName: runner.serverProcessName,
      processCount: serverProcesses.length,
      processes: serverProcesses,
      health,
    },
    runner: {
      processName: runner.runnerProcessName,
      processCount: runnerProcesses.length,
      processes: runnerProcesses,
    },
  };
}

function redactSecrets(value: string): string {
  return value
    .replace(
      /("(?:authorization|token|access_token|refresh_token|password|secret|api_key)"\s*:\s*")[^"]+(")/gi,
      "$1[REDACTED]$2",
    )
    .replace(
      /(authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      "[REDACTED]",
    );
}

export async function getRunnerLogs(
  config: RunnerConfig,
  stream: "stdout" | "stderr",
  lineLimit: number,
) {
  const fileName = stream === "stdout" ? "runner.stdout.log" : "runner.stderr.log";
  const filePath = assertPathInside(
    config.runner.logsDir,
    path.join(config.runner.logsDir, fileName),
  );

  const linkInfo = await lstat(filePath);
  if (linkInfo.isSymbolicLink()) {
    throw new Error("runner_log_file_must_not_be_symlink");
  }

  const [realLogsDir, realFilePath] = await Promise.all([
    realpath(config.runner.logsDir),
    realpath(filePath),
  ]);
  const safeFilePath = assertPathInside(realLogsDir, realFilePath);

  const handle = await open(safeFilePath, "r");
  try {
    const fileInfo = await stat(safeFilePath);
    const maxBytes = 512 * 1024;
    const start = Math.max(0, fileInfo.size - maxBytes);
    const buffer = Buffer.alloc(fileInfo.size - start);
    if (buffer.length > 0) {
      await handle.read(buffer, 0, buffer.length, start);
    }

    const lines = redactSecrets(buffer.toString("utf8"))
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .slice(-lineLimit);

    return {
      stream,
      file: fileName,
      returnedLines: lines.length,
      truncated: start > 0,
      lines,
    };
  } finally {
    await handle.close();
  }
}
