import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/client") as typeof import("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio") as typeof import("@modelcontextprotocol/client/stdio");

const root = process.cwd();
const serverEntry = path.resolve(root, "apps/system-mcp/dist/index.js");
const client = new Client({ name: "mcp-dock-system-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: root,
});

async function callJson(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const details = result.content.filter((block: { type: string }) => block.type === "text" && "text" in block).map((block: { text?: string }) => block.text ?? "").join("\\n");
    throw new Error(name + " returned an MCP tool error: " + details);
  }
  const textBlock = result.content.find((block: { type: string }) => block.type === "text");
  if (!textBlock || textBlock.type !== "text" || !("text" in textBlock)) {
    throw new Error(name + " did not return text content");
  }
  return JSON.parse(textBlock.text as string) as Record<string, any>;
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((tool: { name: string }) => tool.name);
  const required = [
    "get_system_overview",
    "get_disk_usage",
    "list_processes",
    "list_allowed_roots",
    "list_directory",
    "search_files",
    "scan_large_files",
    "analyze_directory",
    "plan_cleanup",
    "request_cleanup_approval",
    "get_cleanup_approval_status",
    "get_file_metadata",
    "read_text_file",
  ];
  const missing = required.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new Error("missing_tools: " + missing.join(", "));
  }

  const overview = await callJson("get_system_overview", {});
  const disk = await callJson("get_disk_usage", {});
  const processes = await callJson("list_processes", { limit: 10 });
  const roots = await callJson("list_allowed_roots", {});
  const directory = await callJson("list_directory", {
    rootId: "workspace",
    relativePath: ".",
    limit: 30,
  });
  const search = await callJson("search_files", {
    rootId: "workspace",
    query: "README.md",
    limit: 10,
    maxDepth: 6,
  });
  const largeFiles = await callJson("scan_large_files", {
    rootId: "workspace",
    minBytes: 100 * 1024 * 1024,
    limit: 10,
    maxDepth: 8,
    maxEntries: 20000,
  });
  const analysis = await callJson("analyze_directory", {
    rootId: "workspace",
    relativePath: "mcp-dock",
    maxDepth: 6,
    maxEntries: 10000,
  });
  const cleanup = await callJson("plan_cleanup", {
    rootId: "workspace",
    relativePath: "mcp-dock",
    maxDepth: 6,
    maxEntries: 10000,
    maxCandidates: 10,
  });
  const metadata = await callJson("get_file_metadata", {
    rootId: "workspace",
    relativePath: "mcp-dock/README.md",
  });
  const readme = await callJson("read_text_file", {
    rootId: "workspace",
    relativePath: "mcp-dock/README.md",
    maxBytes: 65536,
  });

  if (overview.platform !== "win32" || overview.totalMemoryBytes < 1) {
    throw new Error("system overview response is invalid");
  }
  if (!Array.isArray(disk.volumes) || disk.volumes.length < 1) {
    throw new Error("disk usage response is invalid");
  }
  if (!Array.isArray(processes.processes) || processes.processes.length < 1) {
    throw new Error("process list response is invalid");
  }
  if (!Array.isArray(roots.roots) || !roots.roots.some((item: { id: string }) => item.id === "workspace")) {
    throw new Error("workspace root is not registered");
  }
  if (!Array.isArray(directory.entries) || !Array.isArray(search.files) || !Array.isArray(largeFiles.files) || analysis.fileCount < 1 || cleanup.deletionPerformed !== false || cleanup.manualReviewRequired !== true) {
    throw new Error("filesystem query response is invalid");
  }
  if (String(metadata.relativePath).replaceAll("\\", "/") !== "mcp-dock/README.md" || !String(readme.content).includes("# MCP Dock")) {
    throw new Error("file metadata or bounded text read failed");
  }

  const unsafeApproval = await client.callTool({
    name: "request_cleanup_approval",
    arguments: {rootId: "workspace", relativePath: "mcp-dock", reason: "验收测试：应拒绝任意非缓存目录"},
  });
  if (!unsafeApproval.isError) throw new Error("unsafe cleanup proposal was accepted");

  const traversal = await client.callTool({
    name: "get_file_metadata",
    arguments: { rootId: "workspace", relativePath: "../config/system.yaml" },
  });
  if (!traversal.isError) {
    throw new Error("path traversal was not rejected");
  }

  console.log(JSON.stringify({
    status: "passed",
    server: "mcp-dock-system",
    toolCount: tools.length,
    tools: names,
    platform: overview.platform,
    cpuCount: overview.cpuCount,
    volumeCount: disk.volumes.length,
    processCount: processes.processCount,
    allowedRootCount: roots.roots.length,
    listedEntries: directory.returnedEntries,
    searchResults: search.returnedFiles,
    largeFilesScannedEntries: largeFiles.scannedEntries,
    largeFilesTruncated: largeFiles.truncated,
    analyzedFileCount: analysis.fileCount,
    analyzedBytes: analysis.measuredBytes,
    cleanupCandidateCount: cleanup.candidateCount,
    cleanupDeletionPerformed: cleanup.deletionPerformed,
    readmeBytes: readme.sizeBytes,
    pathTraversalRejected: traversal.isError,
    unsafeApprovalRejected: unsafeApproval.isError,
  }, null, 2));
} finally {
  await client.close();
}
