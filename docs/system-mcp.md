# System MCP

System MCP 是 MCP Dock 的第二个本地 STDIO Server，负责本机系统、磁盘和登记目录内的文件检索。它与 Local Dev MCP 分开部署，避免把系统权限、文件权限和 Git/Runner 能力混成一个大工具。

## 本机范围

当前配置文件：`config/system-mcp.yaml`（本机文件，已加入 Git 忽略）

示例登记根：

| rootId | 名称 | 示例路径 |
|---|---|---|
| `workspace` | 示例工作区 | `D:/workspace/your-workspace` |

实际允许访问的目录由使用者在本机 YAML 中自行登记。真实路径不得写入仓库文档或发布包。不会因为模型传入 C 盘或 D 盘绝对路径就扩大访问范围。增加目录时，需要用户修改本机 YAML 配置并重启 Server。

## 工具能力

- 系统：`get_system_overview`、`list_processes`
- 磁盘：`get_disk_usage`
- 目录：`list_allowed_roots`、`list_directory`、`analyze_directory`
- 文件：`search_files`、`scan_large_files`、`get_file_metadata`、`read_text_file`
- 清理分析：`plan_cleanup`
- 审批计划：`request_cleanup_approval`（只保存计划元数据）、`get_cleanup_approval_status`（只读状态）

## 扫描行为

- 文件搜索只匹配文件名，不会全文索引文件内容。
- 搜索默认跳过 `.git`、`node_modules`、`dist`、`build`、`target`、`.gradle`、`.idea` 等常见生成目录。
- 大文件扫描和目录分析可通过 `includeGenerated=true` 包含这些生成目录，但仍跳过 Git 元数据和敏感目录。
- 扫描受本机配置的最大深度和最大条目数限制；返回 `truncated` / `complete` 字段，避免将不完整结果误认为完整盘点。
- 大文件扫描只返回文件名、相对路径、字节数和修改时间，不读取内容。
- `plan_cleanup` 只识别 `dist`、`build`、`target`、`node_modules`、`.gradle`、`.npm`、`.venv`、`__pycache__` 等明确类别，给出估算大小和文件数；扫描不完整时会标记 `complete=false`。
- 清理计划始终返回 `deletionPerformed=false` 和 `manualReviewRequired=true`，不会删除文件或目录。

## 文本读取

- 仅支持常见文本扩展名。
- 默认最多 64 KiB，绝对上限 128 KiB。
- 拒绝敏感文件、二进制文件和符号链接。
- 对常见 API Key、Token、Password、Authorization、Bearer Token、GitHub Token 和 PEM 私钥格式做启发式脱敏。
- 脱敏并非完美秘密检测，因此根目录仍需保持最小授权。

## 权限边界

System MCP 不能修改、移动或删除目标文件，但可以将审批计划元数据保存在本地 `.local/approval`。即使发现可清理目录，也只是生成候选清单或申请人工审批；批准操作仅能在独立 CLI 进行。票据核销和真实执行均不作为 MCP Tool，目前没有实际清理执行器。详见 [审批 Core](approval-core.md)。
