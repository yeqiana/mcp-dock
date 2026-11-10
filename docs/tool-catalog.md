# MCP Dock 工具清单

当前包含两个独立 STDIO Server。Local Dev MCP 为只读；System MCP 除查询外，仅可创建待人工审批计划元数据，不会执行目标文件操作。

## Local Dev MCP

| Tool | 参数 | 说明 |
|---|---|---|
| `list_projects` | 无 | 列出本地登记项目 |
| `get_project_info` | `projectId` | 获取项目登记信息 |
| `git_status` | `projectId` | 获取 Git 分支和工作区变更 |
| `git_log` | `projectId`, `limit` | 获取最近 1–20 条提交记录 |
| `git_branches` | `projectId` | 列出本地分支 |
| `get_webcodex_runner_status` | 无 | 检查 WebCodex Server / Runner 进程与健康端点 |
| `get_webcodex_runner_logs` | `stream`, `lines` | 读取固定 stdout/stderr 日志末尾 |

参数约束：

- `projectId` 必须匹配 `config/projects.yaml` 中的登记 ID。
- `git_log.limit` 范围为 1–20，默认 10。
- Runner 日志 `stream` 只能是 `stdout` 或 `stderr`；`lines` 范围为 1–200，默认 80。

## System MCP

| Tool | 参数 | 说明 |
|---|---|---|
| `get_system_overview` | 无 | OS、CPU、内存和运行时长 |
| `get_disk_usage` | 无 | 固定磁盘容量、已用和剩余空间 |
| `list_processes` | `limit` | 按内存占用列出进程，不含命令行参数 |
| `list_allowed_roots` | 无 | 查看文件检索授权根目录 |
| `list_directory` | `rootId`, `relativePath`, `limit` | 列出直接子项和有限元数据 |
| `search_files` | `rootId`, `query`, `limit`, `maxDepth`, `includeGenerated` | 按文件名搜索，不搜索文件内容 |
| `scan_large_files` | `rootId`, `minBytes`, `limit`, `maxDepth`, `maxEntries`, `includeGenerated` | 扫描大文件，默认跳过常见生成目录 |
| `analyze_directory` | `rootId`, `relativePath`, `maxDepth`, `maxEntries`, `includeGenerated` | 统计测得体积、文件/目录数量和最大文件 |
| `plan_cleanup` | `rootId`, `relativePath`, `maxDepth`, `maxEntries`, `maxCandidates` | 识别常见缓存/构建产物并估算体积，只生成待复核清单 |
| `request_cleanup_approval` | `rootId`, `relativePath`, `reason` | 为固定候选目录生成签名审批计划及 ID；只写审批元数据 |
| `get_cleanup_approval_status` | `planId` | 只读查询计划及审批状态，不返回票据 |
| `get_file_metadata` | `rootId`, `relativePath` | 获取普通文件元数据 |
| `read_text_file` | `rootId`, `relativePath`, `maxBytes` | 有界读取常见文本文件并脱敏 |

参数与扫描边界：

- `rootId` 必须匹配 `config/system-mcp.yaml` 中的登记 ID；当前本机只有 `workspace`。
- 所有文件路径都是相对登记根的路径；拒绝绝对路径、路径穿越和符号链接。
- `list_directory.limit` 范围为 1–200，默认 100。
- `search_files.limit` 范围为 1–100，默认 50；`maxDepth` 最大 16，实际还会受配置上限约束。
- `scan_large_files.minBytes` 最小 1 MiB，默认 50 MiB；`maxEntries` 和 `maxDepth` 均受本机配置上限约束。
- `analyze_directory` 返回的是按扫描策略测得的体积；若 `complete=false`，说明受深度或条目预算限制，不能视为目录完整总量。
- `plan_cleanup` 只识别明确列入候选类别的构建产物和依赖缓存；返回估算字节数、文件数和完整性标记，不执行删除，所有候选都需要人工复核。
- `request_cleanup_approval` 只接受明确的候选目录，要求完整的资源快照；超 10,000 条目或深度 16 时拒绝。审批/拒绝仅能经独立本地 CLI 完成。
- `read_text_file.maxBytes` 默认 64 KiB，最大 128 KiB；敏感文件和二进制文件拒绝读取。

## 当前不提供

- 任意 Shell 或命令执行。
- 文件写入、移动、删除。
- Git checkout、commit、push、reset。
- Runner 启动、停止、重启。
- 自动清理、回收站清空或缓存删除。
- 通过 MCP 批准、拒绝或核销审批票据；目前没有实际清理执行器。
