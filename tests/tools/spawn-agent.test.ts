import { describe, expect, test } from 'bun:test';
import { createSpawnTool, waitForInputTool } from '../../src/tools/built-in';
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

    expect(result).toContain('[Agent "k8s-expert" spawned in background with Task ID:');
    expect(taskRunner.listTasks()).toHaveLength(1);
    expect(taskRunner.listTasks()[0]?.agentName).toBe('k8s-expert');
  });
});

describe('wait_for_input tool', () => {
  const mockMemory: Memory = {
    add: async () => {},
    search: async () => [],
    getRecent: async () => [],
    getLearnings: async () => [],
    getRelevantContext: async () => [],
  };

  const mockLLM: LLM = {
    chat: async () => ({ content: 'done', tool_calls: undefined }),
  };

  test('returns error when no task runner is available', async () => {
    const ctx: Context = {
      agentId: 'agent-1',
      memory: mockMemory,
      llm: mockLLM,
      workingDir: process.cwd(),
      skills: [],
    };

    const result = await waitForInputTool.handler(
      { question: 'What file?' },
      ctx,
    );

    expect(result).toBe('No task runner available — cannot wait for input.');
  });

  test('blocks until sendInput resolves', async () => {
    const taskRunner = new TaskRunner();
    const agentState = {
      id: 'test-agent',
      name: 'test',
      systemPrompt: 'test',
      messages: [],
      tools: new Map(),
      skills: [],
      llm: mockLLM,
      memory: mockMemory,
      workingDir: process.cwd(),
      maxIterations: 10,
      iteration: 0,
    };

    // Submit a task so the taskRunner knows about this agent
    const task = taskRunner.submitTask(agentState, 'test task');

    const ctx: Context = {
      agentId: task.agentId,
      memory: mockMemory,
      llm: mockLLM,
      workingDir: process.cwd(),
      skills: [],
      taskRunner,
    };

    // Start waiting (this will create a promise that blocks)
    const waitPromise = waitForInputTool.handler(
      { question: 'Which file to check?' },
      ctx,
    );

    // Verify the task is now waiting
    const updated = taskRunner.getTask(task.id);
    expect(updated?.status).toBe('waiting');
    expect(updated?.waitingPrompt).toBe('Which file to check?');

    // Send input to resolve the waiting promise
    const sent = taskRunner.sendInput(task.id, '/etc/config.yaml');
    expect(sent).toBe(true);

    const result = await waitPromise;
    expect(result).toContain('/etc/config.yaml');
  });
});
