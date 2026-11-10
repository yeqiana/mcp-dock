import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadProjectRegistry, loadRunnerConfig } from "@mcp-dock/core";
import { registerLocalDevTools } from "./tools.js";

async function main(): Promise<void> {
  const [registry, runnerConfig] = await Promise.all([
    loadProjectRegistry(),
    loadRunnerConfig(),
  ]);

  await serveStdio(() => {
    const server = new McpServer({
      name: "mcp-dock-local-dev",
      version: "0.1.0",
    });
    registerLocalDevTools(server, registry, runnerConfig);
    return server;
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  // STDIO protocol owns stdout. Startup diagnostics must stay on stderr.
  console.error(`[mcp-dock-local-dev] ${message}`);
  process.exitCode = 1;
});
