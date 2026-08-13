import { randomUUID } from 'crypto';
import type { AgentDef, LLM, Memory, Skill, Tool, Context } from './types';
import { createAgentState, runAgent } from './agent';
import type { TaskRunner } from './task-runner';
import { isAutoApprovable } from '../tools/security';

/**
 * Shared helper for spawning a specialized sub-agent by name.
 * Used by both the `spawn_agent` tool (LLM-driven) and the REPL
 * `/assign` commands (manual, user-driven).
 */
export interface SpawnAgentOptions {
    agentName: string;
    task: string;
    agentDefs: AgentDef[];
    allTools: Tool[];
    llm: LLM;
    memory: Memory;
    skills: Skill[];
    parentId?: string;
    workingDir?: string;
    onApprove?: Context['onApprove'];
    taskRunner?: TaskRunner;
    /** When true, runs the sub-agent in background and returns a task id immediately. */
    async?: boolean;
}

export async function spawnAgent(opts: SpawnAgentOptions): Promise<string> {
    const def = opts.agentDefs.find(a => a.name === opts.agentName);
    if (!def) {
        const available = opts.agentDefs.map(a => a.name).join(', ');
        return `Agent "${opts.agentName}" not found. Available: ${available || '(none loaded)'}`;
    }

    const subStateId = randomUUID();
    const isAsync = Boolean(opts.async && opts.taskRunner);

    const subState = createAgentState({
        id: subStateId,
        name: def.name,
        systemPrompt: def.systemPrompt,
        tools: opts.allTools,
        llm: opts.llm,
        memory: opts.memory,
        skills: opts.skills,
        parentId: opts.parentId,
        workingDir: opts.workingDir ?? process.cwd(),
        onApprove: isAsync
            ? async (tool: string, args: any, risk: string): Promise<boolean> => {
                if (isAutoApprovable(tool, args)) return true;
                const question = `Approve ${tool}? risk:${risk.toUpperCase()} args:${JSON.stringify(args).slice(0, 120)}`;
                const answer = await opts.taskRunner!.waitForInput(subStateId, question);
                return answer.trim().toLowerCase() === 'y';
              }
            : opts.onApprove,
        taskRunner: opts.taskRunner,
    });

    if (isAsync) {
        const taskRecord = opts.taskRunner!.submitTask(subState, opts.task);
        return `[Agent "${def.name}" spawned in background with Task ID: ${taskRecord.id}]`;
    }

    // Register with TaskRunner so waitForInput works for sync agents too
    if (opts.taskRunner) {
        opts.taskRunner.registerSyncAgent(subState, opts.task);
    }

    const { result } = await runAgent(subState, opts.task);
    return `--- ${def.name} output ---\n${result}`;
}
