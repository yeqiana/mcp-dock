# MCP Dock

个人 Windows 本地 MCP 工作台。包含两个独立 STDIO MCP Server：Local Dev MCP 负责项目、Git 与 WebCodex Runner；System MCP 负责系统、磁盘、文件检索及受控审批计划申请。第三阶段增加独立 Approval Core 与人工交互式 CLI。

## 当前状态

- [x] 独立 Git 仓库与 WebCodex 工作区注册
- [x] Local Dev MCP：7 个只读 Tool
- [x] System MCP：11 个查询/分析工具 + 2 个审批计划工具（仅创建元数据与状态查询）
- [x] 两个 MCP Server 的 STDIO 握手、工具发现和真实调用冒烟测试
- [x] 目录白名单、路径穿越拒绝、符号链接拒绝和敏感文件拦截
- [x] 文本读取大小限制与常见凭证格式脱敏
- [x] Codex 用户级 MCP 配置注册
- [ ] Project Context MCP
- [x] 独立人工审批 CLI、签名计划、一次性票据、防重放、链式审计
- [ ] 实际文件/目录操作执行器（尚未开放）

## 环境要求

- Windows 10/11
- Node.js 22+
- npm 10+

## 本地开发与验收

```powershell
npm install
npm run typecheck
npm run build
npm test
npm run smoke:all
npm run approval -- help
```

首次部署时，复制并修改以下本机配置文件：

- `config/projects.example.yaml` → `config/projects.yaml`
- `config/system.example.yaml` → `config/system.yaml`
- `config/system-mcp.example.yaml` → `config/system-mcp.yaml`

本机配置均已加入 Git 忽略规则，不会提交。

## 启动服务

```powershell
npm run start:local-dev
npm run start:system-mcp
```

两个 Server 都使用 STDIO。标准输出只用于 MCP 协议，诊断信息写入标准错误。

## Codex 用户级配置

Codex CLI 与 IDE 扩展共用用户级 `~/.codex/config.toml`。下面是跨机器示例，请将 `C:/path/to/mcp-dock` 替换为仓库实际路径，并确保 `node` 已加入 PATH。不要将本机真实 `config.toml`、凭据或绝对路径复制到仓库或发布包：

```toml
[mcp_servers.mcp_dock_local_dev]
command = "node"
args = ["C:/path/to/mcp-dock/apps/local-dev-mcp/dist/index.js"]
cwd = "C:/path/to/mcp-dock"
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 60
default_tools_approval_mode = "auto"
enabled_tools = [
  "list_projects",
  "get_project_info",
  "git_status",
  "git_log",
  "git_branches",
  "get_webcodex_runner_status",
  "get_webcodex_runner_logs"
]

[mcp_servers.mcp_dock_system]
command = "node"
args = ["C:/path/to/mcp-dock/apps/system-mcp/dist/index.js"]
cwd = "C:/path/to/mcp-dock"
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 120
default_tools_approval_mode = "auto"
enabled_tools = [
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
  "read_text_file"
]
```

验证注册：

```powershell
codex mcp list
```

配置变更后，重启 Codex 或新开会话，再通过 `/mcp` 检查工具列表。

## 两个 MCP 的职责

### Local Dev MCP（7 个工具）

项目登记、项目详情、Git status/log/branches、WebCodex Runner 进程/健康状态/日志。

### System MCP（13 个工具：11 个查询/分析 + 2 个审批计划）

系统概览、磁盘空间、进程列表、目录浏览、文件搜索、大文件扫描、目录体积分析、清理候选计划、文件元数据、受限文本读取，以及创建待审批计划和查询审批状态。

System MCP 当前只允许访问 `config/system-mcp.yaml` 登记的工作区根目录。搜索默认跳过常见依赖和构建目录；大文件扫描可显式包含构建产物，但有深度和条目预算。

完整工具参数见 [工具清单](docs/tool-catalog.md)、[审批 Core](docs/approval-core.md)、[System MCP 说明](docs/system-mcp.md)、[安全设计](docs/security.md) 和 [验收记录](docs/acceptance.md)。

## 第三阶段：审批 Core

Agent 只可申请清理计划（`request_cleanup_approval`）及查看状态（`get_cleanup_approval_status`）；不能调用批准或执行工具。本机用户需在独立交互式终端查看计划并手动确认：

```powershell
npm run approval -- list
npm run approval -- show <planId>
npm run approval -- approve <planId>
npm run approval -- reject <planId>
npm run approval -- audit <planId>
```

审批计划有效期 60 分钟，一次性票据最长 10 分钟。票据消费接口当前仅在内部库供测试和后续执行器使用，**不执行清理、不开放给 MCP**。本地审批数据放在已忽略的 `.local/approval`。

## 安全边界

- Local Dev MCP 只读，System MCP 额外允许保存待审批计划元数据；两个 MCP 均不提供目标文件修改、移动、删除、Git 修改或 Runner 启停。
- Codex 配置使用 `enabled_tools` 显式白名单。
- System MCP 不接受任意磁盘路径，只接受已登记 rootId + 相对路径。
- 拒绝路径穿越、符号链接和常见凭证文件；文本读取最大 128 KiB，默认 64 KiB，并对常见凭证格式脱敏。
- 进程列表不返回命令行参数或环境变量。
- 磁盘审计和清理分析只生成证据，不会执行删除。
- 后续写操作必须经过独立本地人工审批 CLI；审批能力不得暴露为 MCP Tool。

## 目录结构

```text
apps/local-dev-mcp/   # 项目、Git、WebCodex Runner
apps/system-mcp/      # 系统、磁盘、文件检索及申请审批计划
apps/approval-cli/    # 独立的人工交互审批命令行
packages/approval-core/ # 计划签名、一次性票据、资源快照和审计
packages/core/        # 路径守卫、固定进程执行、项目注册、Runner
config/               # 本机配置与示例
scripts/              # STDIO 冒烟测试
tests/                # Node.js 内置测试
docs/                 # 架构、安全、工具清单和验收文档
```
