import { describe, expect, test, mock } from 'bun:test';
import { TaskRunner } from '../../src/core/task-runner';
import type { AgentState, LLM, Memory } from '../../src/core/types';

function createMockAgentState(): AgentState {
  const mockMemory: Memory = {
    add: async () => {},
    search: async () => [],
    getRecent: async () => [],
    getLearnings: async () => [],
    getRelevantContext: async () => [],
  };

  const mockLLM: LLM = {
    chat: async () => ({
      content: 'Task completed successfully',
      tool_calls: undefined,
    }),
  };

  return {
    id: 'test-agent',
    name: 'sre-agent',
    systemPrompt: 'You are an SRE agent.',
    messages: [],
    tools: new Map(),
    skills: [],
    llm: mockLLM,
    memory: mockMemory,
    workingDir: process.cwd(),
    maxIterations: 10,
    iteration: 0,
  };
}

describe('TaskRunner & Event Bus (Task 4.1)', () => {
  test('submits task and returns TaskRecord immediately', () => {
    const runner = new TaskRunner();
    const agentState = createMockAgentState();

    const task = runner.submitTask(agentState, 'check system status');

    expect(task.id).toBeDefined();
    expect(task.status).toBe('queued');
    expect(task.taskPrompt).toBe('check system status');
    expect(runner.listTasks()).toHaveLength(1);
  });

  test('executes task asynchronously and updates status to completed', async () => {
    const runner = new TaskRunner();
    const agentState = createMockAgentState();

    const task = runner.submitTask(agentState, 'inspect cluster');

    // Wait for microtask execution
    await new Promise(resolve => setTimeout(resolve, 50));

    const updated = runner.getTask(task.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.result).toBe('Task completed successfully');
  });

  test('handles task cancellation cleanly', () => {
    const runner = new TaskRunner();
    const agentState = createMockAgentState();

    const task = runner.submitTask(agentState, 'long running investigation');
    const cancelled = runner.cancelTask(task.id);

    expect(cancelled).toBe(true);
    expect(runner.getTask(task.id)?.status).toBe('cancelled');
  });

  test('emits event notifications on task state changes', async () => {
    const runner = new TaskRunner();
    const agentState = createMockAgentState();

    const submittedFn = mock(() => {});
    const startedFn = mock(() => {});
    const completedFn = mock(() => {});

    runner.on('submitted', submittedFn);
    runner.on('started', startedFn);
    runner.on('completed', completedFn);

    runner.submitTask(agentState, 'run diagnostics');

    expect(submittedFn).toHaveBeenCalledTimes(1);

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(startedFn).toHaveBeenCalledTimes(1);
    expect(completedFn).toHaveBeenCalledTimes(1);
  });
});
