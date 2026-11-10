import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import path from "node:path";
import { ApprovalService } from "@mcp-dock/approval-core";
import type { SystemConfig } from "./config.js";
import {
  analyzeDirectory,
  getFileMetadata,
  listDirectory,
  planCleanup,
  readTextFile,
  scanLargeFiles,
  searchFiles,
} from "./filesystem.js";
import { getDiskUsage, getSystemOverview, listProcesses } from "./system.js";

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

async function safely<T>(handler: () => Promise<T> | T) {
  try {
    return textResult(await handler());
  } catch (error) {
    return errorResult(error);
  }
}

export function registerSystemTools(server: McpServer, config: SystemConfig): void {
  const approval = new ApprovalService({
    stateDir: path.resolve(import.meta.dirname, "../../../.local/approval"),
    roots: config.roots,
  });
  server.registerTool(
    "get_system_overview",
    {
      description: "只读获取本机 Windows、CPU、内存和运行时长概览，不读取环境变量或用户凭证。",
      inputSchema: z.object({}).strict(),
    },
    async () => safely(() => getSystemOverview()),
  );

  server.registerTool(
    "get_disk_usage",
    {
      description: "只读获取本机固定磁盘容量、已用空间和剩余空间，不执行清理。",
      inputSchema: z.object({}).strict(),
    },
    async () => safely(() => getDiskUsage()),
  );

  server.registerTool(
    "list_processes",
    {
      description: "只读列出本机进程名称、PID 和内存占用，不返回命令行参数或环境变量。",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(30),
      }).strict(),
    },
    async ({ limit }) => safely(() => listProcesses(limit)),
  );

  server.registerTool(
    "list_allowed_roots",
    {
      description: "列出 System MCP 被允许检索的目录根，不允许模型传入任意磁盘路径。",
      inputSchema: z.object({}).strict(),
    },
    async () => safely(() => ({
      roots: [...config.roots.values()].map(({ id, name, path }) => ({ id, name, path })),
      limits: config.limits,
    })),
  );

  server.registerTool(
    "list_directory",
    {
      description: "列出已登记目录中的直接子项，跳过敏感文件和符号链接，只返回有限元数据。",
      inputSchema: z.object({
        rootId: z.string().min(1).max(80),
        relativePath: z.string().max(1024).default("."),
        limit: z.number().int().min(1).max(200).default(100),
      }).strict(),
    },
    async ({ rootId, relativePath, limit }) =>
      safely(() => listDirectory(config, rootId, relativePath, limit)),
  );

  server.registerTool(
    "search_files",
    {
      description: "在已登记目录中按文件名搜索，不搜索文件内容；默认跳过依赖目录、构建产物和敏感目录。",
      inputSchema: z.object({
        rootId: z.string().min(1).max(80),
        query: z.string().trim().min(1).max(120),
        limit: z.number().int().min(1).max(100).default(50),
        maxDepth: z.number().int().min(1).max(16).default(8),
        includeGenerated: z.boolean().default(false),
      }).strict(),
    },
    async ({ rootId, query, limit, maxDepth, includeGenerated }) =>
      safely(() => searchFiles(
        config,
        rootId,
        query,
        limit,
        Math.min(maxDepth, config.limits.maxDepth),
        includeGenerated,
      )),
  );

  server.registerTool(
    "scan_large_files",
    {
      description: "在已登记目录内扫描大文件，支持显式包含常见构建产物；扫描有深度和条目预算，不执行删除。",
      inputSchema: z.object({
        rootId: z.string().min(1).max(80),
        minBytes: z.number().int().min(1024 * 1024).max(1024 * 1024 * 1024 * 1024).default(50 * 1024 * 1024),
        limit: z.number().int().min(1).max(100).default(50),
        maxDepth: z.number().int().min(1).max(16).default(8),
        maxEntries: z.number().int().min(1000).max(100000).default(20000),
        includeGenerated: z.boolean().default(false),
      }).strict(),
    },
    async ({ rootId, minBytes, limit, maxDepth, maxEntries, includeGenerated }) =>
      safely(() => scanLargeFiles(
        config,
        rootId,
        minBytes,
        limit,
        Math.min(maxDepth, config.limits.maxDepth),
        Math.min(maxEntries, config.limits.maxScanEntries),
        includeGenerated,
      )),
  );

  server.registerTool(
    "analyze_directory",
    {
      description: "统计已登记目录内的文件数量、目录数量和测得体积，返回最大的 20 个文件；有扫描预算和深度限制，不执行清理。",
      inputSchema: z.object({
        rootId: z.string().min(1).max(80),
        relativePath: z.string().max(1024).default("."),
        maxDepth: z.number().int().min(1).max(16).default(8),
        maxEntries: z.number().int().min(1000).max(100000).default(20000),
        includeGenerated: z.boolean().default(false),
      }).strict(),
    },
    async ({ rootId, relativePath, maxDepth, maxEntries, includeGenerated }) =>
      safely(() => analyzeDirectory(
        config,
        rootId,
        relativePath,
        Math.min(maxDepth, config.limits.maxDepth),
        Math.min(maxEntries, config.limits.maxScanEntries),
        includeGenerated,
      )),
  );

  server.registerTool(
    "plan_cleanup",
    {
      description: "只读识别已登记目录中的常见构建产物和依赖缓存，估算体积并生成待人工复核清单；绝不执行删除。",
      inputSchema: z.object({
        rootId: z.string().min(1).max(80),
        relativePath: z.string().max(1024).default("."),
        maxDepth: z.number().int().min(1).max(16).default(8),
        maxEntries: z.number().int().min(1000).max(100000).default(20000),
        maxCandidates: z.number().int().min(1).max(50).default(30),
      }).strict(),
    },
    async ({ rootId, relativePath, maxDepth, maxEntries, maxCandidates }) =>
      safely(() => planCleanup(
        config,
        rootId,
        relativePath,
        Math.min(maxDepth, config.limits.maxDepth),
        Math.min(maxEntries, config.limits.maxScanEntries),
        maxCandidates,
      )),
  );

  server.registerTool(
    "request_cleanup_approval",
    {
      description: "为登记目录内的已识别构建/缓存目录生成待人工审批计划。只写入本地审批元数据，不删除/移动目标。不可调用批准或执行。",
      inputSchema: z.object({
        rootId: z.string().min(1).max(80),
        relativePath: z.string().min(1).max(1024),
        reason: z.string().trim().min(1).max(200),
      }).strict(),
    },
    async ({ rootId, relativePath, reason }) =>
      safely(() => approval.proposeCleanup({ rootId, relativePath, reason })),
  );

  server.registerTool(
    "get_cleanup_approval_status",
    {
      description: "只读查看一个待审批清理计划的状态、摘要和资源版本；不返回票据、不批准也不执行操作。",
      inputSchema: z.object({
        planId: z.string().uuid(),
      }).strict(),
    },
    async ({ planId }) => safely(() => approval.inspect(planId)),
  );

  server.registerTool(
    "get_file_metadata",
    {
      description: "读取已登记目录中指定普通文件的元数据；拒绝目录穿越、符号链接和敏感文件。",
      inputSchema: z.object({
        rootId: z.string().min(1).max(80),
        relativePath: z.string().min(1).max(1024),
      }).strict(),
    },
    async ({ rootId, relativePath }) =>
      safely(() => getFileMetadata(config, rootId, relativePath)),
  );

  server.registerTool(
    "read_text_file",
    {
      description: "只读读取已登记目录中的常见文本文件，最大 128 KiB；拒绝敏感文件、二进制文件和符号链接，并对常见凭证格式脱敏。",
      inputSchema: z.object({
        rootId: z.string().min(1).max(80),
        relativePath: z.string().min(1).max(1024),
        maxBytes: z.number().int().min(1024).max(131072).default(65536),
      }).strict(),
    },
    async ({ rootId, relativePath, maxBytes }) =>
      safely(() => readTextFile(config, rootId, relativePath, maxBytes)),
  );
}
