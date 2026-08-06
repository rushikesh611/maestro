import type { Tool, Context, AgentDef } from '../core/types';
import { createAgentState, runAgent } from '../core/agent';
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
            const def = agentDefs.find(a => a.name === args.agent_name);
            if (!def) return `Agent "${args.agent_name}" not found. Available: ${agentDefs.map(a => a.name).join(', ')}`;

            const subState = createAgentState({
                name: def.name,
                systemPrompt: def.systemPrompt,
                tools: allTools,
                llm: ctx.llm,
                memory: ctx.memory,
                skills: ctx.skills,
                parentId: ctx.agentId,
                workingDir: ctx.workingDir,
                onApprove: ctx.onApprove,
                taskRunner: ctx.taskRunner,
            });

            if (args.async && ctx.taskRunner) {
              const taskRecord = ctx.taskRunner.submitTask(subState, args.task);
              return `[Sub-agent "${def.name}" spawned in background with Task ID: ${taskRecord.id}]`;
            }

            const { result } = await runAgent(subState, args.task);
            return `--- ${def.name} output ---\n${result}`;
        },
        risk: 'read',
    };
}