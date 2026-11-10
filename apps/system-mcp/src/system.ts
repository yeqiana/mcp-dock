import os from "node:os";
import path from "node:path";
import { runExecutable } from "@mcp-dock/core";

function getSystemRoot(): string {
  return process.env.SystemRoot ?? "C:\\Windows";
}

function getPowerShellPath(): string {
  return path.join(getSystemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function getTasklistPath(): string {
  return path.join(getSystemRoot(), "System32", "tasklist.exe");
}
export function getSystemOverview() {
  const cpus = os.cpus();
  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  return {
    platform: process.platform,
    operatingSystem: os.type(),
    release: os.release(),
    architecture: os.arch(),
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCount: cpus.length,
    totalMemoryBytes,
    freeMemoryBytes,
    usedMemoryBytes: totalMemoryBytes - freeMemoryBytes,
    memoryUsagePercent: totalMemoryBytes > 0
      ? Number((((totalMemoryBytes - freeMemoryBytes) / totalMemoryBytes) * 100).toFixed(1))
      : 0,
    uptimeSeconds: Math.floor(os.uptime()),
    observedAt: new Date().toISOString(),
  };
}

export async function getDiskUsage() {
  if (process.platform !== "win32") {
    throw new Error("disk_usage_query_requires_windows");
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' |",
    "Select-Object @{Name='drive';Expression={$_.DeviceID}}, @{Name='label';Expression={$_.VolumeName}}, @{Name='sizeBytes';Expression={[int64]$_.Size}}, @{Name='freeBytes';Expression={[int64]$_.FreeSpace}} |",
    "ConvertTo-Json -Compress",
  ].join("\n");

  const result = await runExecutable(
    getPowerShellPath(),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { cwd: process.cwd(), timeoutMs: 15_000, maxBufferBytes: 128 * 1024 },
  );

  const parsed = JSON.parse(result.stdout.trim()) as
    | Array<{ drive: string; label: string | null; sizeBytes: number; freeBytes: number }>
    | { drive: string; label: string | null; sizeBytes: number; freeBytes: number };

  const volumes = Array.isArray(parsed) ? parsed : [parsed];
  return {
    observedAt: new Date().toISOString(),
    volumes: volumes.map((volume) => ({
      drive: volume.drive,
      label: volume.label ?? "",
      sizeBytes: Number(volume.sizeBytes),
      freeBytes: Number(volume.freeBytes),
      usedBytes: Number(volume.sizeBytes) - Number(volume.freeBytes),
      usedPercent: Number(volume.sizeBytes) > 0
        ? Number((((Number(volume.sizeBytes) - Number(volume.freeBytes)) / Number(volume.sizeBytes)) * 100).toFixed(1))
        : 0,
    })),
  };
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"' && value.length === 0) {
      quoted = true;
    } else if (character === ",") {
      fields.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  fields.push(value);
  return fields;
}

export async function listProcesses(limit: number) {
  if (process.platform !== "win32") {
    throw new Error("process_list_requires_windows");
  }

  const result = await runExecutable(
    getTasklistPath(),
    ["/FO", "CSV", "/NH"],
    { cwd: process.cwd(), timeoutMs: 10_000, maxBufferBytes: 512 * 1024 },
  );

  const processes = result.stdout.split(/\r?\n/).flatMap((line) => {    if (!line.trim()) return [];
    const fields = parseCsvLine(line);
    if (fields.length < 5) return [];
    const memoryKib = Number(fields[4]!.replace(/[^0-9]/g, ""));
    return [{
      name: fields[0]!,
      processId: Number(fields[1]),
      sessionName: fields[2]!,
      sessionNumber: fields[3]!,
      memoryBytes: Number.isFinite(memoryKib) ? memoryKib * 1024 : 0,
    }];
  });

  processes.sort((a, b) => b.memoryBytes - a.memoryBytes);
  return {
    observedAt: new Date().toISOString(),
    processCount: processes.length,
    returnedProcesses: Math.min(processes.length, limit),
    processes: processes.slice(0, limit),
  };
}
