import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ApprovalService, type ApprovalStatus } from "@mcp-dock/approval-core";
import { loadSystemConfig } from "../../system-mcp/dist/config.js";

function usage(): void {
  console.log([
    "MCP Dock 审批 CLI（只批准/拒绝，不执行文件操作）",
    "",
    "命令：",
    "  npm run approval -- list",
    "  npm run approval -- show <planId>",
    "  npm run approval -- audit <planId>",
    "  npm run approval -- approve <planId>   # 必须在交互式终端手动输入确认语句",
    "  npm run approval -- reject <planId>    # 必须在交互式终端手动输入确认语句",
    "",
    "注意：不提供 --yes、--force、stdin 管道确认或非交互式批准。",
  ].join("\n"));
}

function safeDisplay(input: string): string {
  return input.replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
}

function display(status: ApprovalStatus): void {
  const { plan } = status;
  console.log([
    "操作计划：" + plan.id,
    "当前状态：" + status.status,
    "操作类型：" + plan.operation,
    "目标根 ID：" + plan.rootId,
    "目标相对路径：" + safeDisplay(plan.relativePath),
    "清理分类：" + plan.category,
    "申请原因：" + safeDisplay(plan.reason),
    "预计涉及文件：" + plan.fileCount,
    "预计涉及目录：" + plan.directoryCount,
    "扫描估算字节：" + plan.estimatedBytes,
    "计划摘要：" + plan.planHash,
    "资源快照：" + plan.resourceVersion,
    "创建时间：" + plan.createdAt,
    "计划到期：" + plan.expiresAt,
    "票据到期：" + (status.approvalExpiresAt ?? "尚未批准"),
    "真实操作执行：" + (status.executionPerformed ? "是" : "否"),
  ].join("\n"));
}

async function requireHumanConfirmation(action: "APPROVE" | "REJECT", id: string): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("approval_requires_interactive_tty");
  }
  const challenge = action + " " + id.slice(0, 8);
  console.log("");
  console.log("请确认计划路径、资源摘要和预期影响。本命令不会实际删除任何文件。");
  console.log("必须手动输入：" + challenge);
  const reader = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    const response = await reader.question("> ");
    if (response !== challenge) throw new Error("approval_confirmation_mismatch");
  } finally {
    reader.close();
  }
}

async function main(): Promise<void> {
  const [command, id, extra] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    usage();
    return;
  }
  if (extra || !["list", "show", "audit", "approve", "reject"].includes(command)) {
    throw new Error("approval_cli_arguments_invalid");
  }
  if (command !== "list" && !id) throw new Error("approval_plan_id_required");
  if (command === "list" && id) throw new Error("approval_cli_arguments_invalid");
  if ((command === "approve" || command === "reject") && (!stdin.isTTY || !stdout.isTTY)) {
    throw new Error("approval_requires_interactive_tty");
  }
  const config = await loadSystemConfig(
    path.resolve(import.meta.dirname, "../../../config/system-mcp.yaml"),
  );
  const service = new ApprovalService({
    stateDir: path.resolve(import.meta.dirname, "../../../.local/approval"),
    roots: config.roots,
  });

  switch (command) {
    case "list": {
      const plans = await service.listPlans();
      if (plans.length === 0) {
        console.log("当前无审批计划");
        return;
      }
      for (const plan of plans) {
        console.log(plan.plan.id + "  " + plan.status + "  " +
          safeDisplay(plan.plan.relativePath) + "  " + plan.plan.createdAt);
      }
      return;
    }
    case "show":
      display(await service.inspect(id!));
      return;
    case "audit": {
      const entries = await service.readAudit(id!);
      if (!entries.length) throw new Error("approval_audit_not_found");
      for (const item of entries) {
        console.log(item.sequence + " " + item.time + " " + item.kind +
          "  " + item.hash);
      }
      return;
    }
    case "approve": {
      const status = await service.inspect(id!);
      display(status);
      if (status.status !== "pending") throw new Error("approval_not_pending");
      await requireHumanConfirmation("APPROVE", id!);
      const granted = await service.approve(id!);
      console.log("");
      console.log("审批已签发。以下是一次性敏感票据，请勿公开、提交到 Git 或记录在日志中：");
      console.log(granted.ticket);
      console.log("票据到期：" + granted.expiresAt);
      console.log("本阶段不提供实际执行入口，因此没有删除或移动任何文件。");
      return;
    }
    case "reject": {
      const status = await service.inspect(id!);
      display(status);
      if (status.status !== "pending") throw new Error("approval_not_pending");
      await requireHumanConfirmation("REJECT", id!);
      await service.reject(id!);
      console.log("已拒绝该操作计划；没有执行文件操作。");
      return;
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "approval_cli_failed");
  process.exitCode = 1;
});
