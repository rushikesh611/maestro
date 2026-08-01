import { spawn } from 'bun';

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Executes a shell command with a configurable timeout and process cancellation.
 * Default timeout: 30,000ms (30 seconds).
 */
export async function runShellCommand(command: string, options?: ExecOptions): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const cwd = options?.cwd || process.cwd();
  const isWin = process.platform === 'win32';

  const proc = spawn({
    cmd: isWin ? ['cmd', '/c', command] : ['sh', '-c', command],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGTERM');
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* process already dead */
          }
        }, 1000);
      } catch {
        /* ignore kill errors */
      }
      resolve(`[Command Timed Out after ${timeoutMs}ms]`);
    }, timeoutMs);
  });

  const executionPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (timedOut) {
      return `[Command Timed Out after ${timeoutMs}ms]\nPartial Output:\n${stdout || stderr}`;
    }

    if (exitCode !== 0) {
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      return `Exit ${exitCode}\n${output || '(no output)'}`;
    }

    return stdout || stderr || '(no output)';
  })();

  try {
    return await Promise.race([executionPromise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
