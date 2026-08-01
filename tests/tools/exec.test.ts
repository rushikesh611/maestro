import { describe, expect, test } from 'bun:test';
import { runShellCommand } from '../../src/tools/exec-runner';

describe('Shell Execution Module (Task 1.2)', () => {
  test('executes fast commands cleanly', async () => {
    const result = await runShellCommand('echo "hello maestro"');
    expect(result.trim()).toContain('hello maestro');
  });

  test('handles failing commands returning stderr/exit code', async () => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'dir non_existent_folder_xyz_123' : 'ls non_existent_folder_xyz_123';
    const result = await runShellCommand(cmd);
    expect(result).toMatch(/Exit|not found|cannot find|No such file/i);
  });

  test('enforces process execution timeout and terminates runaway command', async () => {
    const startTime = Date.now();
    const isWin = process.platform === 'win32';
    // Run sleep for 5 seconds, but with 400ms timeout
    const sleepCmd = isWin ? 'ping -n 6 127.0.0.1 > nul' : 'sleep 5';

    const result = await runShellCommand(sleepCmd, { timeoutMs: 400 });
    const duration = Date.now() - startTime;

    expect(result).toContain('[Command Timed Out after 400ms]');
    // Duration should be close to 400ms, well below 5 seconds
    expect(duration).toBeLessThan(2500);
  });
});
