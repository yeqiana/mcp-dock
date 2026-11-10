import { execFile } from "node:child_process";
import type { ExecFileOptionsWithStringEncoding } from "node:child_process";

export interface ExecuteOptions {
  cwd: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
}

/**
 * Execute a fixed native executable with literal argv.
 * Shell execution is intentionally never enabled.
 */
export async function runExecutable(
  executable: string,
  args: string[],
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  const execOptions: ExecFileOptionsWithStringEncoding = {
    cwd: options.cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMs ?? 15_000,
    maxBuffer: options.maxBufferBytes ?? 512 * 1024,
  };

  return await new Promise<ExecuteResult>((resolve, reject) => {
    execFile(executable, args, execOptions, (error, stdout, stderr) => {
      if (error) {
        const details = [
          error.message,
          stderr.trim(),
        ].filter(Boolean).join("\n");

        reject(new Error(`${executable} failed: ${details}`, { cause: error }));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}
