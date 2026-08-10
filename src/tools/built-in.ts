import type { Tool, Context, AgentDef } from '../core/types';
import { spawnAgent } from '../core/spawn';
import { runShellCommand } from './exec-runner';

export const execTool: Tool = {
    name: 'exec',
    description: 'Execute a shell command. Prefer read-only investigation commands before mutations.',
    parameters: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'Shell command to run' },
            cwd: { type: 'string', description: 'Working directory (optional)' },
        },
        required: ['command'],
    },
    handler: async (args: { command: string; cwd?: string }, ctx: Context) => {
        return runShellCommand(args.command, { cwd: args.cwd || ctx.workingDir });
    },
    risk: 'mutate',
};


export const readFileTool: Tool = {
    name: 'read_file',
    description: 'Read a file from disk',
    parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
    },
    handler: async (args: { path: string }) => {
        try {
            return await Bun.file(args.path).text();
        } catch (e: any) {
            return `Error: ${e.message}`;
        }
    },
    risk: 'read',
};

export const writeFileTool: Tool = {
    name: 'write_file',
    description: 'Write text to a file',
    parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
    },
    handler: async (args: { path: string; content: string }) => {
        await Bun.write(args.path, args.content);
        return `Wrote ${args.path}`;
    },
    risk: 'mutate',
};

export const webFetchTool: Tool = {
    name: 'web_fetch',
    description: 'Fetch a URL and return text content (truncated to 15k chars)',
    parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
    },
    handler: async (args: { url: string }) => {
        try {
            const res = await fetch(args.url, { headers: { 'User-Agent': 'SRE-Agent/1.0' } });
            const text = await res.text();
            return text.slice(0, 15000) + (text.length > 15000 ? '\n...[truncated]' : '');
        } catch (e: any) {
            return `Error: ${e.message}`;
        }
    },
    risk: 'read',
};


/**
 * Tool that lets an agent pause and ask the user for input.
 * The agent loop naturally blocks on the Promise returned by the handler
 * until the user responds via `/send <task-id> <input>`.
 */
export const waitForInputTool: Tool = {
    name: 'wait_for_input',
    description: 'Pause and ask the user for additional input. Use when you need clarification, more information, or approval before proceeding. The task will wait until the user responds.',
    parameters: {
        type: 'object',
        properties: {
            question: { type: 'string', description: 'Question or prompt for the user' },
        },
        required: ['question'],
    },
    handler: async (args: { question: string }, ctx: Context) => {
        if (!ctx.taskRunner) {
            return 'No task runner available — cannot wait for input.';
        }

        // Show the question to the user
        process.stdout.write(`\n\x1b[43m\x1b[30m ⏸️  WAITING \x1b[0m ${args.question}\n`);
        process.stdout.write(`\x1b[90m   (Type your response below, or /send <task-id> for bg tasks)\x1b[0m\n\n`);

        const tr = ctx.taskRunner as any;

        // Start the event-based wait (works for background tasks via /send)
        const bgPromise = ctx.taskRunner.waitForInput(ctx.agentId, args.question);

        if (tr.isSyncAgent?.(ctx.agentId) || ctx.agentId === 'main') {
            // ── Sync / foreground agent — REPL is blocked ─────────────────
            // Prompt directly so the user can respond inline.
            const { createInterface } = await import('readline');
            const rli = createInterface({ input: process.stdin, output: process.stdout });
            const input = await new Promise<string>((resolve) => {
                rli.question('> ', (answer: string) => {
                    rli.close();
                    resolve(answer);
                });
            });
            // Also resolve the bg promise (for cleanup / status tracking)
            tr.sendInput?.(ctx.agentId, input);
            return `User responded: ${input}`;
        } else {
            // ── Background task — main REPL is still live ─────────────────
            // User will use /send <task-id> to respond.
            const input = await bgPromise;
            return `User responded: ${input}`;
        }
    },
    risk: 'read',
};

export const thinkTool: Tool = {
    name: 'think',
    description: 'Use this to reason step-by-step and create a numbered plan before acting. Label steps: [READ], [INVESTIGATE], [MUTATE].',
    parameters: {
        type: 'object',
        properties: { reasoning: { type: 'string' } },
        required: ['reasoning'],
    },
    handler: async (args: { reasoning: string }) => `Plan: ${args.reasoning}`,
    risk: 'read',
};

export function createSpawnTool(agentDefs: AgentDef[], allTools: Tool[]): Tool {
    return {
        name: 'spawn_agent',
        description: 'Spawn a specialized sub-agent. Available presets: ' + agentDefs.map(a => a.name).join(', '),
        parameters: {
            type: 'object',
            properties: {
                agent_name: { type: 'string', description: 'Agent preset name' },
                task: { type: 'string', description: 'Task prompt for the sub-agent' },
                async: { type: 'boolean', description: 'Set true to run sub-agent in background without blocking parent agent' },
            },
            required: ['agent_name', 'task'],
        },
        handler: async (args: { agent_name: string; task: string; async?: boolean }, ctx: Context) => {
            return spawnAgent({
                agentName: args.agent_name,
                task: args.task,
                async: args.async,
                agentDefs,
                allTools,
                llm: ctx.llm,
                memory: ctx.memory,
                skills: ctx.skills,
                parentId: ctx.agentId,
                workingDir: ctx.workingDir,
                onApprove: ctx.onApprove,
                taskRunner: ctx.taskRunner,
            });
        },
        risk: 'read',
    };
}