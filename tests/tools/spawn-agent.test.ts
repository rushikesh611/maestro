import { describe, expect, test } from 'bun:test';
import { createSpawnTool } from '../../src/tools/built-in';
import { TaskRunner } from '../../src/core/task-runner';
import type { AgentDef, Context, LLM, Memory } from '../../src/core/types';

describe('Asynchronous Sub-Agent Workers (Task 4.2)', () => {
  const agentDefs: AgentDef[] = [
    {
      name: 'k8s-expert',
      description: 'Kubernetes specialist agent',
      systemPrompt: 'You are a K8s expert.',
    },
  ];

  const mockMemory: Memory = {
    add: async () => {},
    search: async () => [],
    getRecent: async () => [],
    getLearnings: async () => [],
    getRelevantContext: async () => [],
  };

  const mockLLM: LLM = {
    chat: async () => ({
      content: 'Sub-agent investigation finished cleanly',
      tool_calls: undefined,
    }),
  };

  test('runs sub-agent synchronously when async is false/omitted', async () => {
    const spawnTool = createSpawnTool(agentDefs, []);
    const ctx: Context = {
      agentId: 'parent-1',
      memory: mockMemory,
      llm: mockLLM,
      workingDir: process.cwd(),
      skills: [],
    };

    const result = await spawnTool.handler(
      { agent_name: 'k8s-expert', task: 'Check pod logs' },
      ctx,
    );

    expect(result).toContain('--- k8s-expert output ---');
    expect(result).toContain('Sub-agent investigation finished cleanly');
  });

  test('spawns sub-agent in background when async is true', async () => {
    const taskRunner = new TaskRunner();
    const spawnTool = createSpawnTool(agentDefs, []);
    const ctx: Context = {
      agentId: 'parent-1',
      memory: mockMemory,
      llm: mockLLM,
      workingDir: process.cwd(),
      skills: [],
      taskRunner,
    };

    const result = await spawnTool.handler(
      { agent_name: 'k8s-expert', task: 'Monitor pod CPU', async: true },
      ctx,
    );

    expect(result).toContain('[Sub-agent "k8s-expert" spawned in background with Task ID:');
    expect(taskRunner.listTasks()).toHaveLength(1);
    expect(taskRunner.listTasks()[0]?.agentName).toBe('k8s-expert');
  });
});
