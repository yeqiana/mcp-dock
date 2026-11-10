import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  access,
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  snapshotCleanupDirectory,
  type ApprovalRoot,
  type ResourceSnapshot,
} from "./snapshot.js";

const PLAN_TTL_MS = 60 * 60 * 1000;
const GRANT_TTL_MS = 10 * 60 * 1000;
const PLAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonCanonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(jsonCanonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value as object).sort().map((key) =>
      JSON.stringify(key) + ":" + jsonCanonical((value as Record<string, unknown>)[key]),
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(a) || !/^[0-9a-f]{64}$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function validPlanId(id: string): void {
  if (!PLAN_ID.test(id)) throw new Error("invalid_approval_plan_id");
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeExclusive(file: string, value: unknown): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

type Signed<T> = T & { signature: string };

export interface CleanupPlan {
  version: 1;
  id: string;
  operation: "cleanup-directory";
  rootId: string;
  relativePath: string;
  category: ResourceSnapshot["category"];
  reason: string;
  resourceVersion: string;
  fileCount: number;
  directoryCount: number;
  estimatedBytes: number;
  scannedEntries: number;
  createdAt: string;
  expiresAt: string;
  planHash: string;
}

interface GrantRecord {
  version: 1;
  planId: string;
  planHash: string;
  resourceVersion: string;
  issuedAt: string;
  expiresAt: string;
  ticketHash: string;
}
interface RejectionRecord {
  version: 1;
  planId: string;
  planHash: string;
  rejectedAt: string;
}
interface ConsumptionRecord {
  version: 1;
  planId: string;
  planHash: string;
  resourceVersion: string;
  consumedAt: string;
  ticketHash: string;
  executionPerformed: false;
}

export interface AuditEntry {
  version: 1;
  planId: string;
  sequence: number;
  time: string;
  kind: "proposed" | "approved" | "rejected" | "ticket_consumed";
  details: Record<string, string | number | boolean>;
  previousHash: string;
  hash: string;
  signature: string;
}

export type ApprovalState = "pending" | "approved" | "rejected" | "consumed" | "expired";

export interface ApprovalStatus {
  plan: CleanupPlan;
  status: ApprovalState;
  approvalExpiresAt: string | null;
  executionPerformed: false;
}

export interface ExpectedCleanup {
  operation: "cleanup-directory";
  rootId: string;
  relativePath: string;
  resourceVersion: string;
  planHash: string;
}

export class ApprovalService {
  private readonly stateDir: string;
  private readonly roots: ReadonlyMap<string, ApprovalRoot>;
  private readonly now: () => number;
  private cachedKey: Buffer | null = null;

  constructor(options: {
    stateDir: string;
    roots: ReadonlyMap<string, ApprovalRoot>;
    now?: () => number;
  }) {
    this.stateDir = path.resolve(options.stateDir);
    this.roots = options.roots;
    this.now = options.now ?? Date.now;
  }

  private location(group: string, id: string, ext = ".json"): string {
    validPlanId(id);
    return path.join(this.stateDir, group, id + ext);
  }

  private async init(): Promise<void> {
    for (const dir of [
      this.stateDir,
      ...["plans", "grants", "rejections", "consumed", "audit", "locks"].map(
        (part) => path.join(this.stateDir, part),
      ),
    ]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("approval_state_directory_unsafe");
    }
    const keyFile = path.join(this.stateDir, "secret.key");
    if (!this.cachedKey) {
      try {
        await writeExclusive(keyFile, { key: randomBytes(32).toString("hex") });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const info = await lstat(keyFile);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("approval_signing_key_unsafe");
      const parsed = JSON.parse(await readFile(keyFile, "utf8")) as { key: string };
      if (!/^[0-9a-f]{64}$/.test(parsed.key)) throw new Error("invalid_approval_signing_key");
      this.cachedKey = Buffer.from(parsed.key, "hex");
    }
  }

  private sign(value: unknown): string {
    if (!this.cachedKey) throw new Error("approval_store_not_initialized");
    return createHmac("sha256", this.cachedKey).update(jsonCanonical(value)).digest("hex");
  }

  private seal<T extends object>(payload: T): Signed<T> {
    return { ...payload, signature: this.sign(payload) };
  }

  private async verified<T extends object>(file: string): Promise<Signed<T>> {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072) {
      throw new Error("approval_record_unsafe");
    }
    const { signature, ...record } = JSON.parse(await readFile(file, "utf8")) as Signed<T>;
    if (!equalHex(signature, this.sign(record))) throw new Error("approval_record_signature_invalid");
    return { ...(record as T), signature };
  }

  private async verifyPlan(id: string): Promise<CleanupPlan> {
    const { signature: _signature, ...plan } =
      await this.verified<CleanupPlan>(this.location("plans", id));
    const { planHash, ...unsigned } = plan;
    if (!equalHex(planHash, sha256(jsonCanonical(unsigned))) || id !== plan.id) {
      throw new Error("approval_plan_hash_mismatch");
    }
    return plan;
  }

  private async verifyGrant(id: string, plan: CleanupPlan): Promise<GrantRecord | null> {
    const file = this.location("grants", id);
    if (!await fileExists(file)) return null;
    const { signature: _signature, ...grant } = await this.verified<GrantRecord>(file);
    if (grant.planId !== id || grant.planHash !== plan.planHash ||
        grant.resourceVersion !== plan.resourceVersion) {
      throw new Error("approval_grant_plan_binding_mismatch");
    }
    return grant;
  }

  private async withPlanLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    validPlanId(id);
    await this.init();
    const lockPath = this.location("locks", id, ".lock");
    try {
      await mkdir(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("approval_plan_busy_fail_closed");
      }
      throw error;
    }
    try {
      return await action();
    } finally {
      await rmdir(lockPath);
    }
  }

  private async appendAudit(
    id: string,
    kind: AuditEntry["kind"],
    details: AuditEntry["details"],
  ): Promise<void> {
    const previous = await this.readAudit(id);
    const unsigned = {
      version: 1 as const,
      planId: id,
      sequence: previous.length + 1,
      time: new Date(this.now()).toISOString(),
      kind,
      details,
      previousHash: previous.at(-1)?.hash ?? "0".repeat(64),
    };
    const hash = sha256(jsonCanonical(unsigned));
    const entry = this.seal({ ...unsigned, hash });
    const auditFile = this.location("audit", id, ".jsonl");
    const handle = await open(auditFile, "a", 0o600);
    try {
      await handle.writeFile(JSON.stringify(entry) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async readAudit(id: string): Promise<AuditEntry[]> {
    validPlanId(id);
    await this.init();
    const file = this.location("audit", id, ".jsonl");
    if (!await fileExists(file)) return [];
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
      throw new Error("approval_audit_file_unsafe");
    }
    const content = await readFile(file, "utf8");
    if (!content.endsWith("\n")) throw new Error("approval_audit_truncated");
    const lines = content.split("\n").filter(Boolean);
    const result: AuditEntry[] = [];
    for (const line of lines) {
      const { signature, hash, ...unsigned } = JSON.parse(line) as AuditEntry;
      if (
        unsigned.planId !== id ||
        unsigned.sequence !== result.length + 1 ||
        unsigned.previousHash !== (result.at(-1)?.hash ?? "0".repeat(64)) ||
        !equalHex(hash, sha256(jsonCanonical(unsigned))) ||
        !equalHex(signature, this.sign({ ...unsigned, hash }))
      ) throw new Error("approval_audit_integrity_failed");
      result.push({ ...unsigned, hash, signature });
    }
    return result;
  }

  async proposeCleanup(input: {
    rootId: string;
    relativePath: string;
    reason: string;
  }): Promise<ApprovalStatus> {
    await this.init();
    const reason = input.reason.trim();
    if (!reason || reason.length > 200 || /[\x00-\x1f]/.test(reason)) {
      throw new Error("approval_reason_invalid");
    }
    const snapshot = await snapshotCleanupDirectory(this.roots, input.rootId, input.relativePath);
    const id = randomUUID();
    const createdAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + PLAN_TTL_MS).toISOString();
    const unsigned = {
      version: 1 as const,
      id,
      operation: "cleanup-directory" as const,
      rootId: snapshot.rootId,
      relativePath: snapshot.relativePath,
      category: snapshot.category,
      reason,
      resourceVersion: snapshot.versionDigest,
      fileCount: snapshot.fileCount,
      directoryCount: snapshot.directoryCount,
      estimatedBytes: snapshot.totalBytes,
      scannedEntries: snapshot.scannedEntries,
      createdAt,
      expiresAt,
    };
    const plan = { ...unsigned, planHash: sha256(jsonCanonical(unsigned)) };
    await this.withPlanLock(id, async () => {
      await writeExclusive(this.location("plans", id), this.seal(plan));
      await this.appendAudit(id, "proposed", {
        operation: plan.operation, rootId: plan.rootId,
        relativePath: plan.relativePath, planHash: plan.planHash,
        resourceVersion: plan.resourceVersion,
      });
    });
    return { plan, status: "pending", approvalExpiresAt: null, executionPerformed: false };
  }

  async inspect(id: string): Promise<ApprovalStatus> {
    await this.init();
    const plan = await this.verifyPlan(id);
    const events = await this.readAudit(id);
    if (
      events[0]?.kind !== "proposed" ||
      events[0]?.details.planHash !== plan.planHash ||
      events[0]?.details.resourceVersion !== plan.resourceVersion
    ) throw new Error("approval_proposal_audit_missing");
    const rejectedFile = this.location("rejections", id);
    const consumedFile = this.location("consumed", id);
    const grant = await this.verifyGrant(id, plan);
    const rejected = await fileExists(rejectedFile);
    const consumed = await fileExists(consumedFile);
    if (rejected) {
      const record = await this.verified<RejectionRecord>(rejectedFile);
      if (record.planId !== id || record.planHash !== plan.planHash) {
        throw new Error("approval_rejection_binding_mismatch");
      }
    }
    if (consumed) {
      const record = await this.verified<ConsumptionRecord>(consumedFile);
      if (record.planId !== id || record.planHash !== plan.planHash ||
          record.resourceVersion !== plan.resourceVersion ||
          record.ticketHash !== grant?.ticketHash) {
        throw new Error("approval_consumption_binding_mismatch");
      }
    }
    if (rejected && (grant || consumed)) throw new Error("approval_conflicting_states");
    // If a process dies after writing the grant/marker but before writing its
    // audit event, refuse to trust the partially persisted transition.
    const approvedEvents = events.filter((event) => event.kind === "approved");
    const rejectedEvents = events.filter((event) => event.kind === "rejected");
    const consumedEvents = events.filter((event) => event.kind === "ticket_consumed");
    if (
      (grant ? approvedEvents.length !== 1 : approvedEvents.length !== 0) ||
      (rejected ? rejectedEvents.length !== 1 : rejectedEvents.length !== 0) ||
      (consumed ? consumedEvents.length !== 1 : consumedEvents.length !== 0) ||
      events.length !== 1 + approvedEvents.length + rejectedEvents.length + consumedEvents.length ||
      (grant && approvedEvents[0]?.details.planHash !== plan.planHash) ||
      (consumed && consumedEvents[0]?.details.executionPerformed !== false)
    ) throw new Error("approval_audit_state_incomplete");

    let status: ApprovalState = "pending";
    if (consumed) status = "consumed";
    else if (rejected) status = "rejected";
    else if (Date.parse(plan.expiresAt) <= this.now() ||
             (grant && Date.parse(grant.expiresAt) <= this.now())) status = "expired";
    else if (grant) status = "approved";
    return {
      plan,
      status,
      approvalExpiresAt: grant?.expiresAt ?? null,
      executionPerformed: false,
    };
  }
  async listPlans(limit = 30): Promise<ApprovalStatus[]> {
    await this.init();
    const files = (await readdir(path.join(this.stateDir, "plans")))
      .filter((name) => name.endsWith(".json") && PLAN_ID.test(name.slice(0, -5)))
      .sort().reverse().slice(0, Math.min(Math.max(limit, 1), 100));
    return Promise.all(files.map((name) => this.inspect(name.slice(0, -5))));
  }

  async approve(id: string): Promise<{ plan: CleanupPlan; ticket: string; expiresAt: string }> {
    return this.withPlanLock(id, async () => {
      const status = await this.inspect(id);
      if (status.status !== "pending") throw new Error("approval_not_pending");
      const plan = status.plan;
      const snapshot = await snapshotCleanupDirectory(this.roots, plan.rootId, plan.relativePath);
      if (!equalHex(snapshot.versionDigest, plan.resourceVersion)) {
        throw new Error("approval_resource_changed");
      }
      if (this.now() >= Date.parse(plan.expiresAt)) throw new Error("approval_plan_expired");
      const nonce = randomBytes(32).toString("base64url");
      const ticket = "apv1." + id + "." + nonce;
      const issuedAt = new Date(this.now()).toISOString();
      const expiresAt = new Date(Math.min(this.now() + GRANT_TTL_MS, Date.parse(plan.expiresAt))).toISOString();
      const grant: GrantRecord = {
        version: 1, planId: id, planHash: plan.planHash,
        resourceVersion: plan.resourceVersion, issuedAt, expiresAt, ticketHash: sha256(ticket),
      };
      await writeExclusive(this.location("grants", id), this.seal(grant));
      await this.appendAudit(id, "approved", {
        planHash: plan.planHash, resourceVersion: plan.resourceVersion, expiresAt,
      });
      return { plan, ticket, expiresAt };
    });
  }

  async reject(id: string): Promise<void> {
    await this.withPlanLock(id, async () => {
      const status = await this.inspect(id);
      if (status.status !== "pending") throw new Error("approval_not_pending");
      const rejection: RejectionRecord = {
        version: 1, planId: id, planHash: status.plan.planHash,
        rejectedAt: new Date(this.now()).toISOString(),
      };
      await writeExclusive(this.location("rejections", id), this.seal(rejection));
      await this.appendAudit(id, "rejected", { planHash: status.plan.planHash });
    });
  }

  // Executor-only library boundary. Never expose this as an MCP tool. No filesystem
  // cleanup, Git mutation or Runner operation is performed in this version.
  async consumeTicket(ticket: string, expected: ExpectedCleanup): Promise<{
    planId: string; authorized: true; executionPerformed: false;
  }> {
    const match = /^apv1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(ticket);
    if (!match) throw new Error("approval_ticket_format_invalid");
    const id = match[1]!;
    return this.withPlanLock(id, async () => {
      const status = await this.inspect(id);
      if (status.status !== "approved") throw new Error("approval_ticket_not_active");
      const plan = status.plan;
      const grant = await this.verifyGrant(id, plan);
      if (!grant) throw new Error("approval_grant_missing");
      if (!equalHex(sha256(ticket), grant.ticketHash)) throw new Error("approval_ticket_invalid");
      if (
        expected.operation !== plan.operation ||
        expected.rootId !== plan.rootId ||
        expected.relativePath !== plan.relativePath ||
        !equalHex(expected.resourceVersion, plan.resourceVersion) ||
        !equalHex(expected.planHash, plan.planHash)
      ) throw new Error("approval_ticket_scope_mismatch");

      const snapshot = await snapshotCleanupDirectory(this.roots, plan.rootId, plan.relativePath);
      if (!equalHex(snapshot.versionDigest, plan.resourceVersion)) {
        throw new Error("approval_resource_changed");
      }
      if (this.now() >= Date.parse(grant.expiresAt) || this.now() >= Date.parse(plan.expiresAt)) {
        throw new Error("approval_ticket_expired");
      }
      const record: ConsumptionRecord = {
        version: 1, planId: id, planHash: plan.planHash,
        resourceVersion: plan.resourceVersion, consumedAt: new Date(this.now()).toISOString(),
        ticketHash: grant.ticketHash, executionPerformed: false,
      };
      await writeExclusive(this.location("consumed", id), this.seal(record));
      await this.appendAudit(id, "ticket_consumed", {
        planHash: plan.planHash, resourceVersion: plan.resourceVersion, executionPerformed: false,
      });
      return { planId: id, authorized: true, executionPerformed: false };
    });
  }
}
