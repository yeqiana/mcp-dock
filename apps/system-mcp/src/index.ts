import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadSystemConfig } from "./config.js";
import { registerSystemTools } from "./tools.js";

async function main(): Promise<void> {
  const config = await loadSystemConfig();

  await serveStdio(() => {
    const server = new McpServer({
      name: "mcp-dock-system",
      version: "0.1.0",
    });
    registerSystemTools(server, config);
    return server;
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error("[mcp-dock-system] " + message);
  process.exitCode = 1;
});
