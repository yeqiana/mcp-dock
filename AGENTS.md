# MCP Dock Agent Instructions

## Project boundaries

- This repository is the standalone `mcp-dock` project.
- Do not modify sibling projects or files outside this repository unless the user explicitly authorizes a specific operation.
- Keep the three MCP Server boundaries independent: Local Dev, System, and Project Context.
- Reuse existing WebCodex Runner capabilities only through documented, verified interfaces. Do not guess undocumented endpoints.

## Security requirements

- Local Dev MCP remains read-only. System MCP may persist signed proposal metadata only; neither server may mutate target project files, delete data, change Git, or start/stop Runner services without a new, explicit design review and approval.
- System MCP filesystem access is restricted to configured root IDs and relative paths; preserve traversal, symlink, sensitive-file, scan-budget, and text-read limits.
- Never expose a generic `execute_command(command)` tool.
- Native processes must use fixed executables and argv arrays; never enable `shell: true`.
- Do not accept arbitrary paths from model input. Use the local project registry and path guards.
- Keep STDIO stdout exclusively for MCP protocol messages. Write diagnostics to stderr.
- Do not read credential files or environment files. Redact secrets from any logs that are returned.
- Approval Core may create plan metadata and read status through MCP, but CLI approval/rejection and ticket consumption MUST NOT be exposed as MCP Tools. Future target-file writes require a separate review.

## Development and validation

- Runtime: Node.js 22+, npm workspaces.
- MCP server SDK: official `@modelcontextprotocol/server` v2.
- Run `npm install`, `npm run typecheck`, `npm test`, and `npm run smoke:all` before reporting completion.
- Keep project-local configuration in ignored `config/projects.yaml`, `config/system.yaml`, and `config/system-mcp.yaml`; update the example files when the schema changes.

## Git commit messages

Commit descriptions must be Chinese and use this structure:

```text
feat: 改动内容

模块名称1,模块名称2

mcp-dock
```

Use `fix:`, `docs:`, or `init:` as appropriate. Do not commit or push unless explicitly requested.
