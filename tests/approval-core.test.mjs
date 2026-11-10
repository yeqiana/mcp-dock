import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ApprovalService,
  snapshotCleanupDirectory,
} from "../packages/approval-core/dist/index.js";

const fixtures = [];

async function fixture() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "mcp-dock-approval-"));
  fixtures.push(temp);
  const root = path.join(temp, "workspace");
  const target = path.join(root, "example", "dist");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "bundle.js"), "test build artifact");
  await writeFile(path.join(target, "bundle.css"), "test css artifact");
  const roots = new Map([["workspace", { id: "workspace", name: "Fixture workspace", path: root }]]);
  let now = Date.parse("2026-11-10T08:00:00.000Z");
  const stateDir = path.join(temp, ".local", "approval");
  const service = new ApprovalService({ roots, stateDir, now: () => now });
  return {
    temp, root, target, roots, service, stateDir,
    tick: (delta) => { now += delta; },
    propose: () => service.proposeCleanup({
      rootId: "workspace",
      relativePath: "example/dist",
      reason: "清理可重新生成的测试构建产物",
    }),
  };
}
function expected(plan) {
  return {
    operation: plan.operation,
    rootId: plan.rootId,
    relativePath: plan.relativePath,
    resourceVersion: plan.resourceVersion,
    planHash: plan.planHash,
  };
}

test("审批 CLI 不接受无 TTY 的批准或拒绝", async () => {
  const cli = path.resolve("apps/approval-cli/dist/index.js");
  for (const command of ["approve", "reject"]) {
    await assert.rejects(
      execFileAsync(process.execPath, [cli, command, "00000000-0000-4000-8000-000000000001"]),
      (error) => error.stderr.includes("approval_requires_interactive_tty"),
    );
  }
});

test.after(async () => {
  await Promise.all(fixtures.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("计划只写元数据，目标目录未被删除或修改", async () => {
  const f = await fixture();
  const before = await readFile(path.join(f.target, "bundle.js"), "utf8");
  const proposal = await f.propose();
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.plan.operation, "cleanup-directory");
  assert.equal(proposal.plan.fileCount, 2);
  assert.equal(proposal.plan.category, "build-output");
  assert.match(proposal.plan.resourceVersion, /^[a-f0-9]{64}$/);
  assert.equal((await f.service.inspect(proposal.plan.id)).status, "pending");
  assert.equal((await f.service.readAudit(proposal.plan.id))[0].kind, "proposed");
  assert.equal(await readFile(path.join(f.target, "bundle.js"), "utf8"), before);
});

test("人工拒绝后不允许再批准", async () => {
  const f = await fixture();
  const { plan } = await f.propose();
  await f.service.reject(plan.id);
  assert.equal((await f.service.inspect(plan.id)).status, "rejected");
  await assert.rejects(f.service.approve(plan.id), /approval_not_pending/);
  assert.deepEqual((await f.service.readAudit(plan.id)).map((event) => event.kind),
    ["proposed", "rejected"]);
});

test("一次性票据只能核销一次，核销不执行清理", async () => {
  const f = await fixture();
  const { plan } = await f.propose();
  const grant = await f.service.approve(plan.id);
  assert.match(grant.ticket, /^apv1\./);
  assert.equal((await f.service.inspect(plan.id)).status, "approved");
  const result = await f.service.consumeTicket(grant.ticket, expected(plan));
  assert.equal(result.authorized, true);
  assert.equal(result.executionPerformed, false);
  assert.equal((await f.service.inspect(plan.id)).status, "consumed");
  await assert.rejects(f.service.consumeTicket(grant.ticket, expected(plan)),
    /approval_ticket_not_active/);
  assert.deepEqual((await f.service.readAudit(plan.id)).map((entry) => entry.kind),
    ["proposed", "approved", "ticket_consumed"]);
  assert.equal(await readFile(path.join(f.target, "bundle.js"), "utf8"), "test build artifact");
});

test("操作对象、计划摘要或票据被篡改时拒绝核销", async () => {
  const f = await fixture();
  const { plan } = await f.propose();
  const grant = await f.service.approve(plan.id);
  await assert.rejects(
    f.service.consumeTicket(grant.ticket, { ...expected(plan), relativePath: "other/dist" }),
    /approval_ticket_scope_mismatch/,
  );
  await assert.rejects(
    f.service.consumeTicket(grant.ticket, { ...expected(plan), planHash: "f".repeat(64) }),
    /approval_ticket_scope_mismatch/,
  );
  await assert.rejects(
    f.service.consumeTicket(grant.ticket.slice(0, -2) + "ab", expected(plan)),
    /approval_ticket_invalid/,
  );
  assert.equal((await f.service.inspect(plan.id)).status, "approved");
});

test("批准前目标发生变化时拒绝批准", async () => {
  const f = await fixture();
  const { plan } = await f.propose();
  await writeFile(path.join(f.target, "added.js"), "new output");
  await assert.rejects(f.service.approve(plan.id), /approval_resource_changed/);
  assert.equal((await f.service.inspect(plan.id)).status, "pending");
});

test("批准后目标变化时拒绝核销", async () => {
  const f = await fixture();
  const { plan } = await f.propose();
  const { ticket } = await f.service.approve(plan.id);
  await writeFile(path.join(f.target, "bundle.js"), "changed resource");
  await assert.rejects(f.service.consumeTicket(ticket, expected(plan)),
    /approval_resource_changed/);
  assert.equal((await f.service.inspect(plan.id)).status, "approved");
});

test("票据到期和计划到期均拒绝操作", async () => {
  const f = await fixture();
  const first = await f.propose();
  const grant = await f.service.approve(first.plan.id);
  f.tick(11 * 60 * 1000);
  assert.equal((await f.service.inspect(first.plan.id)).status, "expired");
  await assert.rejects(f.service.consumeTicket(grant.ticket, expected(first.plan)),
    /approval_ticket_not_active/);

  const second = await f.propose();
  f.tick(61 * 60 * 1000);
  await assert.rejects(f.service.approve(second.plan.id), /approval_not_pending/);
});

test("并发核销只能有一个成功", async () => {
  const f = await fixture();
  const { plan } = await f.propose();
  const grant = await f.service.approve(plan.id);
  const outcomes = await Promise.allSettled([
    f.service.consumeTicket(grant.ticket, expected(plan)),
    f.service.consumeTicket(grant.ticket, expected(plan)),
  ]);
  assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal((await f.service.readAudit(plan.id)).filter(
    (entry) => entry.kind === "ticket_consumed",
  ).length, 1);
});

test("修改计划或审计文件后校验失败并阻断批准", async () => {
  const a = await fixture();
  const { plan: first } = await a.propose();
  const planFile = path.join(a.stateDir, "plans", first.id + ".json");
  const changed = JSON.parse(await readFile(planFile, "utf8"));
  changed.relativePath = "unexpected/dist";
  await writeFile(planFile, JSON.stringify(changed));
  await assert.rejects(a.service.approve(first.id), /approval_record_signature_invalid/);

  const b = await fixture();
  const { plan: second } = await b.propose();
  const auditFile = path.join(b.stateDir, "audit", second.id + ".jsonl");
  await writeFile(auditFile, (await readFile(auditFile, "utf8")).replace(
    "proposed", "approved",
  ));
  await assert.rejects(b.service.approve(second.id), /approval_audit_integrity_failed/);
});

test("审批已落盘但审计缺失时故障关闭", async () => {
  const f = await fixture();
  const { plan } = await f.propose();
  const { ticket } = await f.service.approve(plan.id);
  const file = path.join(f.stateDir, "audit", plan.id + ".jsonl");
  const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
  await writeFile(file, lines[0] + "\n");
  await assert.rejects(f.service.inspect(plan.id), /approval_audit_state_incomplete/);
  await assert.rejects(f.service.consumeTicket(ticket, expected(plan)), /approval_audit_state_incomplete/);
});

test("拒绝目录穿越、非候选目录和符号链接", async (t) => {
  const f = await fixture();
  await assert.rejects(
    f.service.proposeCleanup({ rootId: "workspace", relativePath: "../example/dist", reason: "test" }),
    /unsafe_cleanup_path/,
  );
  await assert.rejects(
    f.service.proposeCleanup({ rootId: "workspace", relativePath: "example", reason: "test" }),
    /not_a_supported_cleanup_candidate/,
  );
  await assert.rejects(
    f.service.proposeCleanup({ rootId: "workspace", relativePath: ".git", reason: "test" }),
    /sensitive_cleanup_target_denied/,
  );
  await assert.rejects(
    f.service.proposeCleanup({ rootId: "workspace", relativePath: "example/.local/dist", reason: "test" }),
    /sensitive_cleanup_target_denied/,
  );
  const outside = path.join(f.temp, "external");
  await mkdir(outside);
  try {
    await symlink(outside, path.join(f.root, "symlink"), "junction");
  } catch {
    t.skip("Windows junction creation not supported");
    return;
  }
  await assert.rejects(
    snapshotCleanupDirectory(f.roots, "workspace", "symlink/dist"),
    /cleanup_symlink_denied/,
  );
});

test("拒绝缺少证据的敏感清理候选，不能自动覆盖授权目录", async () => {
  const f = await fixture();
  const tokenFixture = ["not", "to", "be", "read"].join("-");
  await writeFile(path.join(f.target, ".env"), "API_TOKEN=" + tokenFixture);  await assert.rejects(f.propose(), /sensitive_cleanup_target_denied/);
});

test("列表只暴露状态，不泄漏票据", async () => {
  const f = await fixture();
  const { plan } = await f.propose();
  const { ticket } = await f.service.approve(plan.id);
  const all = await f.service.listPlans();
  assert.equal(all.length, 1);
  assert.equal(all[0].status, "approved");
  assert.equal(JSON.stringify(all).includes(ticket), false);
});
