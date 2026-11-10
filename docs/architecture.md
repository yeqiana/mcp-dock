# MCP Dock 架构

## 当前阶段

Windows 本地部署，两个职责分离的 STDIO MCP Server。Codex 通过 MCP Host 启动独立 Node.js 进程，JSON-RPC 消息只经过 STDIO。

```text
Codex / MCP Host
   |
   +-- STDIO --> mcp-dock-local-dev
   |                |
   |                +-- ProjectRegistry
   |                |     +-- config/projects.yaml
   |                +-- Git Adapter
   |                |     +-- git status / log / branch
   |                +-- WebCodex Runner Adapter
   |                      +-- tasklist.exe
   |                      +-- GET /healthz
   |                      +-- 固定 stdout/stderr 日志
   |
   +-- STDIO --> mcp-dock-system
                    |
                    +-- System Adapter
                    |     +-- os.cpus / os.totalmem
                    |     +-- PowerShell 固定磁盘查询
                    |     +-- tasklist.exe
                    |
                    +-- Filesystem Adapter
                          +-- config/system-mcp.yaml
                          +-- 登记 rootId
                          +-- 路径与符号链接守卫
                          +-- 有预算的目录遍历
                          +-- 敏感文件拦截 / 文本脱敏
                          +-- 清理候选估算（只读，不删除）
                          +-- request_cleanup_approval（只写审批元数据）
                          +-- get_cleanup_approval_status（不返回票据）
```

## 独立审批层

```text
用户终端 --> apps/approval-cli (TTY 确认)
                     |
                     v
          packages/approval-core
          +-- 签名计划 / 审批存储
          +-- 快照绑定 / 票据核销
          +-- 审计链 / 并发锁
          +-- .local/approval/ （Git 忽略）
```

**批准、拒绝和核销不作为 MCP 工具提供。** 本阶段没有实际文件删除执行器。

## Server 职责

| Server | 负责范围 | 工具数 |
|---|---|---:|
| Local Dev MCP | 项目、Git、WebCodex Runner | 7 |
| System MCP | 系统、磁盘、进程、文件和审批计划元数据 | 13 |
| Project Context MCP | 项目文档、架构约束、决策记录 | 后续阶段 |

## 关键设计约束

- 项目路径来自 `config/projects.yaml`，文件检索根来自 `config/system-mcp.yaml`。
- MCP 输入只允许传项目 ID、rootId 和相对路径，不允许模型指定任意绝对路径。
- 所有原生进程使用固定 executable 与 argv 数组，不启用 shell。
- System MCP 目录扫描有最大深度和最大条目数，返回是否截断。
- `plan_cleanup` 只估算常见缓存/构建目录，不执行删除。
- 文本读取只允许常见文本扩展名，限制字节数并做常见凭证格式脱敏。
- 不读取环境变量、命令行参数或系统凭证。
- STDIO stdout 专用于 MCP 协议；诊断输出到 stderr。
- System MCP 只允许保存签名审批元数据，不提供目标文件写入、删除、Git 修改或 Runner 启停。
- Approval Core 票据消费不等于已执行目标操作，当前无实际执行器。

## 后续阶段

1. Project Context MCP：项目文档、架构约束、决策记录和 Resources。
2. 审批执行 Core 基础能力已完成：独立 CLI、一次性票据、摘要绑定、过期检查和审计；真实执行器及更强的 Windows 人机隔离仍待开发。
3. 受控文件修改与清理：先展示差异、目标、影响范围和预计释放空间，再由用户确认。
4. Runner 深度集成：只在确认 WebCodex 本地管理 API 契约后增加服务启停，不猜测或模拟 API。
