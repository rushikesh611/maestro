import { randomUUID } from 'crypto';
import type { AgentState, Message, Context, Skill, Memory, LLM, Tool } from './types';
import { truncateOutput } from '../tools/truncator';
import { selectRelevantSkills } from './skill-rag';
import { applyContextWindow } from './context-window';
import { reflectAndStoreLearnings } from './reflection';

export function createAgentState(cfg: {
    id?: string;
    name: string;
    systemPrompt: string;
    tools: Tool[];
    llm: LLM;
    memory: Memory;
    skills?: Skill[];
    maxIterations?: number;
    workingDir?: string;
    parentId?: string;
    onApprove?: AgentState['onApprove'];
    taskRunner?: AgentState['taskRunner'];
}): AgentState {
    return {
        id: cfg.id || randomUUID(),
        name: cfg.name,
        systemPrompt: cfg.systemPrompt,
        messages: [],
        tools: new Map(cfg.tools.map(t => [t.name, t])),
        skills: cfg.skills ?? [],
        llm: cfg.llm,
        memory: cfg.memory,
        workingDir: cfg.workingDir ?? process.cwd(),
        maxIterations: cfg.maxIterations ?? 30,
        iteration: 0,
        parentId: cfg.parentId,
        onApprove: cfg.onApprove,
        taskRunner: cfg.taskRunner,
    };
}

function buildSystemPrompt(state: AgentState, learnings: string[], recent: string[], context: string[], relevantSkills: Skill[]): string {
    let prompt = state.systemPrompt;
    prompt += `\n\n## Operational Directive\nYou MUST begin every task by using the \`think\` tool to create a numbered plan. Label each step: [READ] for safe observation, [INVESTIGATE] for deep analysis, [MUTATE] for state-changing actions. Present your full plan before executing any other tool.`;

    if (relevantSkills.length) {
        prompt += `\n\n## Relevant Skills\nThese skills were selected as relevant to your current task:\n`;
        for (const skill of relevantSkills) {
            prompt += `\n### ${skill.name}\n${skill.description}\n${skill.content}\n`;
        }
    }

    if (recent.length) {
        prompt += `\n\n## Recent Conversation (last ${recent.length} turns)\n${recent.join('\n')}`;
    }

    if (context.length) {
        prompt += `\n\n## Relevant Memory\n${context.join('\n')}`;
    }

    if (learnings.length) {
        prompt += `\n\n## Past Learnings\n${learnings.map(l => `- ${l}`).join('\n')}`;
    }

    return prompt;
}


export async function runAgent(state: AgentState, task: string): Promise<{ result: string; state: AgentState }> {
    // Fetch memory in parallel
    const [learnings, recentEntries, context] = await Promise.all([
        state.memory.getLearnings(state.id, task),
        state.memory.getRecent(state.id, 'conversation', 4),
        state.memory.getRelevantContext(state.id, task, 5),
    ]);

    // Reverse to get chronological order (getRecent returns newest first)
    const recent = recentEntries.reverse().map(r => r.content.slice(0, 800));

    // Select only the top-3 most relevant skills for this task (RAG)
    const relevantSkills = selectRelevantSkills(task, state.skills, 3);

    const system = buildSystemPrompt(state, learnings, recent, context, relevantSkills);

    let messages: Message[] = [
        { role: 'system', content: system },
        { role: 'user', content: task },
    ];

    await state.memory.add({
        agent_id: state.id,
        type: 'conversation',
        content: `User: ${task}`,
    });

    for (let i = 0; i < state.maxIterations; i++) {
        // Compress older turns before sending to LLM to keep context window bounded
        messages = await applyContextWindow(messages, state.llm);
        state = { ...state, iteration: i, messages };

        const reply = await state.llm.chat(messages, Array.from(state.tools.values()));

        // Emit progress — show iteration, token count, and next action
        const nextCallName = reply.tool_calls?.[0]?.function.name ?? 'thinking';
        let progressMsg = `🔄 [${i + 1}/${state.maxIterations}] ${nextCallName}`;
        if (reply.usage) {
            const pt = reply.usage.prompt_tokens ?? 0;
            const ct = reply.usage.completion_tokens ?? 0;
            progressMsg += `  📊 ${(pt / 1000).toFixed(1)}k→${(ct / 1000).toFixed(1)}k tokens`;
        }
        if (state.name !== 'main') {
            progressMsg = `[${state.name}] ${progressMsg}`;
        }
        state.taskRunner?.emit('task:log', {
            taskId: state.id,
            message: progressMsg,
        });

        if (!reply.tool_calls) {
            const finalContent = reply.content ?? '(no response)';
            messages = [...messages, { role: 'assistant', content: finalContent }];
            await state.memory.add({
              agent_id: state.id,
              type: 'conversation',
              content: `Assistant: ${finalContent}`,
            });
            // Emit live output for real-time streaming
            state.taskRunner?.emit('task:output', { taskId: state.id, role: 'assistant', content: finalContent });
            state.taskRunner?.emit('task:output', { taskId: state.id, role: 'result', content: finalContent });
            // Don't await — let the user see the result immediately
            reflectAndStoreLearnings(state.llm, state.memory, state.id, task, finalContent).catch(() => {});
            return { result: finalContent, state: { ...state, messages } };
          }

        messages = [...messages, {
            role: 'assistant',
            content: reply.content ?? '',
            tool_calls: reply.tool_calls,
        }];

        // Emit assistant message (with tool calls) for live streaming
        const assistantContent = reply.content ?? `(calling ${reply.tool_calls.map(t => t.function.name).join(', ')})`;
        state.taskRunner?.emit('task:output', { taskId: state.id, role: 'assistant', content: assistantContent });

        for (const call of reply.tool_calls) {
            const tool = state.tools.get(call.function.name);
            let result: string;

            try {
                const args = JSON.parse(call.function.arguments);

                // Live event streaming for plans and tool calls
                if (call.function.name === 'think') {
                    state.taskRunner?.emit('task:output', {
                        taskId: state.id,
                        role: 'plan',
                        content: `🧠 Plan: ${args.reasoning}`
                    });
                } else {
                    const argStr = JSON.stringify(args);
                    state.taskRunner?.emit('task:output', {
                        taskId: state.id,
                        role: 'tool_call',
                        content: `⚡ Tool ${call.function.name}(${argStr.slice(0, 150)})`
                    });
                }

                if (tool && tool.risk !== 'read' && state.onApprove) {
                    const approved = await state.onApprove(tool.name, args, tool.risk);
                    if (!approved) {
                        result = `User denied approval for ${tool.name}.`;
                        messages = [...messages, { role: 'tool', content: result, tool_call_id: call.id }];
                        state.taskRunner?.emit('task:output', { taskId: state.id, role: 'tool', content: `⛔ Denied ${tool.name}` });
                        continue;
                    }
                }

                const ctx: Context = {
                    agentId: state.id,
                    parentId: state.parentId,
                    memory: state.memory,
                    llm: state.llm,
                    workingDir: state.workingDir,
                    skills: state.skills,
                    onApprove: state.onApprove,
                    taskRunner: state.taskRunner,
                };

                result = tool
                    ? await tool.handler(args, ctx)
                    : `Tool not found: ${call.function.name}`;
            } catch (err: any) {
                result = `Error: ${err.message}`;
            }

            const truncatedResult = truncateOutput(result);

            messages = [...messages, { role: 'tool', content: truncatedResult, tool_call_id: call.id }];
            await state.memory.add({
                agent_id: state.id,
                type: 'conversation',
                content: `Tool ${call.function.name}: ${truncatedResult.slice(0, 2000)}`,
            });
            // Emit tool result for live streaming (except think tool which emits plan)
            if (call.function.name !== 'think') {
                state.taskRunner?.emit('task:output', {
                    taskId: state.id,
                    role: 'tool',
                    content: `📋 Result (${call.function.name}): ${truncatedResult.slice(0, 250)}`
                });
            }
        }
    }

    return { result: 'Max iterations reached.', state: { ...state, messages } };
}