import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/client") as typeof import("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio") as typeof import("@modelcontextprotocol/client/stdio");

const root = process.cwd();
const serverEntry = path.resolve(root, "apps/local-dev-mcp/dist/index.js");
const client = new Client({ name: "mcp-dock-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: root,
});

async function callJson(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`${name} returned an MCP tool error`);
  }

  const textBlock = result.content.find((block: { type: string }) => block.type === "text");
  if (!textBlock || textBlock.type !== "text" || !("text" in textBlock)) {
    throw new Error(`${name} did not return text content`);
  }

  return JSON.parse(textBlock.text as string) as Record<string, any>;
}

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((tool: { name: string }) => tool.name);
  const required = [
    "list_projects",
    "get_project_info",
    "git_status",
    "git_log",
    "git_branches",
    "get_webcodex_runner_status",
    "get_webcodex_runner_logs",
  ];

  const missing = required.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new Error(`missing_tools: ${missing.join(", ")}`);
  }

  const projects = await callJson("list_projects", {});
  if (!Array.isArray(projects) || !projects.some((project: { id: string }) => project.id === "mcp-dock")) {
    throw new Error("mcp-dock project is missing from the local registry");
  }

  const projectInfo = await callJson("get_project_info", { projectId: "mcp-dock" });
  const gitStatus = await callJson("git_status", { projectId: "mcp-dock" });
  const gitLog = await callJson("git_log", { projectId: "mcp-dock", limit: 5 });
  const gitBranches = await callJson("git_branches", { projectId: "mcp-dock" });
  const runnerStatus = await callJson("get_webcodex_runner_status", {});
  const runnerLogs = await callJson("get_webcodex_runner_logs", { stream: "stdout", lines: 20 });

  if (projectInfo.id !== "mcp-dock" || projectInfo.exists !== true) {
    throw new Error("get_project_info returned an invalid project record");
  }
  if (!Array.isArray(gitLog.commits) || !Array.isArray(gitBranches.branches)) {
    throw new Error("Git read-only tool response is invalid");
  }
  if (runnerStatus.runner?.processCount < 1) {
    throw new Error("WebCodex Runner process was not detected");
  }
  if (runnerStatus.server?.health?.reachable !== true) {
    throw new Error("WebCodex Server health check failed");
  }
  if (!Array.isArray(runnerLogs.lines)) {
    throw new Error("Runner log response is invalid");
  }

  console.log(JSON.stringify({
    status: "passed",
    server: "mcp-dock-local-dev",
    toolCount: tools.length,
    tools: names,
    registeredProjects: projects.length,
    projectRootExists: projectInfo.exists,
    gitBranch: gitStatus.branch,
    gitLogCount: gitLog.commits.length,
    localBranchCount: gitBranches.branches.length,
    runnerProcessCount: runnerStatus.runner.processCount,
    serverHealth: runnerStatus.server.health,
    runnerLogLines: runnerLogs.returnedLines,
  }, null, 2));
} finally {
  await client.close();
}
