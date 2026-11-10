# MCP Dock 第一至第三阶段验收记录

## 环境

| 项目 | 实际结果 |
|---|---|
| 操作系统 | Windows |
| Node.js | v22.22.0 |
| npm | 10.9.4 |
| MCP Server SDK | `@modelcontextprotocol/server@2.4.0` |
| MCP Client SDK（冒烟测试） | `@modelcontextprotocol/client@2.4.0` |
| 传输方式 | STDIO |
| Codex 配置 | 用户级 `~/.codex/config.toml` |

## 第一阶段：Local Dev MCP

| 检查项 | 结果 |
|---|---|
| TypeScript 类型检查 / 构建 | 通过 |
| Local Dev 单元测试 | 4/4 通过 |
| MCP 初始化握手和工具发现 | 7 个工具 |
| 项目列表 / 详情 / Git status / log / branches | 真实调用通过 |
| Runner 进程检查 | 检测到 1 个 Runner |
| Server 健康检查 | `GET /healthz` 返回 HTTP 200 |
| Runner 固定日志读取 | 真实调用通过 |
| Codex 用户级 MCP 配置 | 已注册并由 `codex mcp list` 识别 |

## 第二阶段：System MCP

| 检查项 | 结果 | 证据 |
|---|---|---|
| System MCP TypeScript 类型检查 | 通过 | `npm run typecheck` |
| System MCP 构建 | 通过 | `npm run build` |
| Node.js 单元测试（当前全量） | 26/26 通过 | `npm test` |
| STDIO 初始化握手 | 通过 | SDK Client 连接本地 System Server |
| 工具发现 | 13 个 | `client.listTools()` |
| 系统信息 | 通过 | Windows / CPU / 内存信息真实返回 |
| 磁盘空间 | 通过 | 检测到 C:、D: 两个固定磁盘 |
| 进程清单 | 通过 | 返回进程数及内存占用，不含命令行 |
| 目录浏览 | 通过 | 登记工作区根目录成功 |
| 文件名搜索 | 通过 | 返回 README.md 匹配项 |
| 大文件扫描 | 通过 | 20,000 条预算内执行；本次结果标记 truncated |
| 目录分析 | 通过 | 对 mcp-dock 子目录统计文件数和测得体积 |
| 清理候选计划 | 通过 | 返回候选目录及预计字节数，明确 `deletionPerformed=false` |
| 文件元数据 / 文本读取 | 通过 | 读取 MCP Dock README.md |
| 路径穿越拦截 | 通过 | `../config/system.yaml` 被拒绝 |
| 敏感文件、符号链接与大小限制 | 通过 | 单元测试覆盖 .env、.git-credentials、符号链接和超限文本文件 |
| Codex 用户级注册 | 通过 | `codex mcp list` 显示 `mcp_dock_system` 为 enabled |
| 当前 Windows 用户上下文 | 通过 | 两个 MCP 的真实 STDIO 冒烟测试均 exit 0 |

## 第三阶段：Approval Core

| 检查项 | 结果 | 证据 |
|---|---|---|
| TypeScript 构建与类型检查 | 通过 | `npm run typecheck`、`npm run build` |
| 全量单元测试 | 26/26 通过 | `npm test` |
| 独立审批 CLI 启动 | 通过 | `npm run approval -- help` |
| 非交互式审批拦截 | 通过 | 无 TTY 的 approve / reject 均返回拒绝 |
| 计划签名与摘要绑定 | 通过 | 篡改计划后拒绝批准 |
| 审计链校验 | 通过 | 篡改审计或缺少审批落盘事件时拒绝使用 |
| 资源版本绑定 | 通过 | 批准前/后修改测试目录均被拒绝 |
| 一次性票据 | 通过 | 票据不能重复核销 |
| 并发双重核销 | 通过 | 两次并发操作至多一个成功 |
| 过期校验 | 通过 | 计划 60 分钟，票据最多 10 分钟 |
| 非白名单目录审批 | 通过 | System MCP 冒烟调用明确拒绝 |
| 实际文件删除 | 未开放 | `executionPerformed=false`，所有测试均在临时目录 |
| MCP 工具发现 | 通过 | System MCP 当前 13 个工具（其中两个审批计划工具） |

本阶段签发、拒绝和核销**不作为 MCP Tool 暴露**。CLI 交互确认只针对受限 MCP Agent，不构成抵御同 Windows 用户任意代码执行的强身份认证；详见 [审批 Core](approval-core.md)。

## System MCP 配置说明

- MCP Server ID：`mcp_dock_system`
- 启动方式：Node.js + `apps/system-mcp/dist/index.js`
- 允许根目录：由本机 `config/system-mcp.yaml` 显式登记；仓库示例仅使用占位路径
- 扫描预算：最多 30,000 个条目、最大深度 10
- 文本读取：默认 64 KiB，最大 128 KiB
- 本机配置文件 `config/system-mcp.yaml` 已加入 Git 忽略，不进入交付包
- Codex 用户级配置保存在用户目录；仓库只提供占位模板，不包含真实机器配置
- Codex 工具白名单：11 个查询/分析工具 + 2 个审批计划工具
- 本机配置备份只保留在用户目录，不纳入仓库或发布包

## 权限结论

Local Dev MCP 完全只读；System MCP 除查询外，只能持久化审批计划元数据，不开放批准、拒绝、核销或真实执行工具。两个 MCP 均未暴露任意 Shell、目标文件修改/删除、Git 修改或 Runner 启停。

## 尚未完成

- Codex 用户级配置已更新 System MCP 的两个审批工具；已打开的图形客户端仍需重启或新开会话后通过 `/mcp` 确认实际工具可见。
- Project Context MCP 尚未实现。
- 独立人工审批 CLI 已实现；不允许通过 MCP 自动批准。正式生产的独立用户身份验证与隔离尚未实现。
- 文件修改、移动、删除、Git 写操作和 Runner 启停均未开放；任何真实清理执行器仍需专门评审。
- 大文件扫描本次达到 20,000 条目预算，结果明确标记为截断；需要按子目录分批扫描或提高配置预算才能获得更完整的盘点。
