import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  getRunnerLogs,
  getRunnerStatus,
  runExecutable,
  type ProjectRegistry,
  type RunnerConfig,
} from "@mcp-dock/core";

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown_error";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

async function safely<T>(handler: () => Promise<T>) {
  try {
    return textResult(await handler());
  } catch (error) {
    return errorResult(error);
  }
}

function getExistingProject(registry: ProjectRegistry, projectId: string) {
  const project = registry.get(projectId);
  return project;
}

export function registerLocalDevTools(
  server: McpServer,
  registry: ProjectRegistry,
  runnerConfig: RunnerConfig,
): void {
  server.registerTool(
    "list_projects",
    {
      description: "列出 MCP Dock 本地登记的项目，只读取项目配置和目录状态。",
      inputSchema: z.object({}).strict(),
    },
    async () => safely(() => registry.list()),
  );

  server.registerTool(
    "get_project_info",
    {
      description: "读取指定项目的登记信息、目录存在状态和 Git 仓库状态。",
      inputSchema: z.object({ projectId: z.string().min(1).max(80) }).strict(),
    },
    async ({ projectId }) => safely(() => registry.getSummary(projectId)),
  );

  server.registerTool(
    "git_status",
    {
      description: "读取指定项目的 Git 工作区状态，不修改索引或工作区。",
      inputSchema: z.object({ projectId: z.string().min(1).max(80) }).strict(),
    },
    async ({ projectId }) => safely(async () => {
      const project = getExistingProject(registry, projectId);
      const summary = await registry.getSummary(projectId);
      if (!summary.exists) throw new Error("project_directory_not_found");

      const result = await runExecutable(
        "git",
        ["status", "--short", "--branch"],
        { cwd: project.root, timeoutMs: 15_000 },
      );
      const lines = result.stdout.split(/\r?\n/).filter(Boolean);
      const changes = lines.slice(1);

      return {
        projectId,
        branch: lines[0] ?? "unknown",
        changedFileCount: changes.length,
        changes,
      };
    }),
  );

  server.registerTool(
    "git_log",
    {
      description: "读取指定项目最近的 Git 提交记录，最多返回 20 条。",
      inputSchema: z.object({
        projectId: z.string().min(1).max(80),
        limit: z.number().int().min(1).max(20).default(10),
      }).strict(),
    },
    async ({ projectId, limit }) => safely(async () => {
      const project = getExistingProject(registry, projectId);
      const summary = await registry.getSummary(projectId);
      if (!summary.exists || !summary.isGitRepository) {
        throw new Error("project_is_not_an_existing_git_repository");
      }

      try {
        const format = "%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e";
        const result = await runExecutable(
          "git",
          ["log", "-n", String(limit), "--date=iso-strict", `--pretty=format:${format}`],
          { cwd: project.root, timeoutMs: 15_000 },
        );
        const commits = result.stdout
          .split("\x1e")
          .filter(Boolean)
          .map((record) => {
            const [hash, shortHash, author, date, subject] = record.split("\x1f");
            return { hash, shortHash, author, date, subject };
          });
        return { projectId, commits };
      } catch (error) {
        if (error instanceof Error && error.message.includes("does not have any commits yet")) {
          return { projectId, commits: [] };
        }
        throw error;
      }
    }),
  );

  server.registerTool(
    "git_branches",
    {
      description: "列出指定项目的本地 Git 分支，不执行分支切换。",
      inputSchema: z.object({ projectId: z.string().min(1).max(80) }).strict(),
    },
    async ({ projectId }) => safely(async () => {
      const project = getExistingProject(registry, projectId);
      const summary = await registry.getSummary(projectId);
      if (!summary.exists || !summary.isGitRepository) {
        throw new Error("project_is_not_an_existing_git_repository");
      }

      const result = await runExecutable(
        "git",
        ["branch", "--format=%(refname:short)"],
        { cwd: project.root, timeoutMs: 15_000 },
      );
      return {
        projectId,
        branches: result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      };
    }),
  );

  server.registerTool(
    "get_webcodex_runner_status",
    {
      description: "只读检查本机 WebCodex Server、Runner 进程和本地健康检查端点。",
      inputSchema: z.object({}).strict(),
    },
    async () => safely(() => getRunnerStatus(runnerConfig)),
  );

  server.registerTool(
    "get_webcodex_runner_logs",
    {
      description: "读取 WebCodex Runner 标准输出或错误日志的末尾内容，最多 200 行，并对常见凭证字段脱敏。",
      inputSchema: z.object({
        stream: z.enum(["stdout", "stderr"]).default("stdout"),
        lines: z.number().int().min(1).max(200).default(80),
      }).strict(),
    },
    async ({ stream, lines }) => safely(() => getRunnerLogs(runnerConfig, stream, lines)),
  );
}
