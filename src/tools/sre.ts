import { spawn } from 'bun';
import type { Tool } from '../core/types';

async function sh(cmd: string, cwd?: string) {
    const isWin = process.platform === 'win32';
    const proc = spawn({
        cmd: isWin ? ['cmd', '/c', cmd] : ['sh', '-c', cmd],
        cwd: cwd || process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    return out || err || '(no output)';
}

export const k8sTools: Tool[] = [
    {
        name: 'kubectl',
        description: 'Run kubectl commands. Examples: "get pods -n prod", "describe pod x", "logs x --tail 50"',
        parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
        },
        handler: async (args: { command: string }) => sh(`kubectl ${args.command}`),
        risk: 'mutate',
    },
    {
        name: 'helm',
        description: 'Run helm commands',
        parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
        },
        handler: async (args: { command: string }) => sh(`helm ${args.command}`),
        risk: 'mutate',
    },
];

export const dockerTools: Tool[] = [
    {
        name: 'docker',
        description: 'Docker CLI operations',
        parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
        },
        handler: async (args: { command: string }) => sh(`docker ${args.command}`),
        risk: 'mutate',
    },
];

export const linuxTools: Tool[] = [
    {
        name: 'journalctl',
        description: 'Query systemd logs',
        parameters: {
            type: 'object',
            properties: {
                unit: { type: 'string' },
                lines: { type: 'number', default: 100 },
                since: { type: 'string', description: 'e.g. "1 hour ago"' },
            },
            required: ['unit'],
        },
        handler: async (args: { unit: string; lines?: number; since?: string }) => {
            let cmd = `journalctl -u ${args.unit} -n ${args.lines ?? 100} --no-pager`;
            if (args.since) cmd += ` --since "${args.since}"`;
            return sh(cmd);
        },
        risk: 'read',
    },
    {
        name: 'ss',
        description: 'Socket statistics (modern netstat replacement)',
        parameters: {
            type: 'object',
            properties: { options: { type: 'string', default: '-tulpn' } },
            required: [],
        },
        handler: async (args: { options?: string }) => sh(`ss ${args.options ?? '-tulpn'}`),
        risk: 'read',
    },
    {
        name: 'strace',
        description: 'Trace system calls of a running process',
        parameters: {
            type: 'object',
            properties: {
                pid: { type: 'number' },
                duration: { type: 'number', description: 'Seconds to trace', default: 5 },
            },
            required: ['pid'],
        },
        handler: async (args: { pid: number; duration?: number }) =>
            sh(`timeout ${args.duration ?? 5} strace -p ${args.pid} 2>&1 || true`),
        risk: 'read',
    },
];