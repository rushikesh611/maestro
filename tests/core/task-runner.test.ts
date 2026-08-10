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

describe('TaskRunner Waiting State (Task Sessions)', () => {
  test('waitForInput creates a waiting state and stores the prompt', () => {
    const runner = new TaskRunner();
    const agentState = createMockAgentState();

    const task = runner.submitTask(agentState, 'check config');

    const promise = runner.waitForInput(task.id, 'Which config file?');

    const updated = runner.getTask(task.id);
    expect(updated?.status).toBe('waiting');
    expect(updated?.waitingForInput).toBe(true);
    expect(updated?.waitingPrompt).toBe('Which config file?');
    expect(promise).toBeInstanceOf(Promise);
  });

  test('sendInput resolves the waiting promise and resumes the task', async () => {
    const runner = new TaskRunner();
    const agentState = createMockAgentState();

    const task = runner.submitTask(agentState, 'check config');
    const promise = runner.waitForInput(task.id, 'Which config file?');

    // Send input
    const sent = runner.sendInput(task.id, '/etc/nginx/nginx.conf');
    expect(sent).toBe(true);

    // The promise should resolve with the input
    const result = await promise;
    expect(result).toBe('/etc/nginx/nginx.conf');

    // Task should be back to running
    const updated = runner.getTask(task.id);
    expect(updated?.status).toBe('running');
    expect(updated?.waitingForInput).toBe(false);
    expect(updated?.waitingPrompt).toBeUndefined();
  });

  test('sendInput returns false if task is not waiting', () => {
    const runner = new TaskRunner();
    const agentState = createMockAgentState();

    const task = runner.submitTask(agentState, 'check config');

    const sent = runner.sendInput(task.id, 'anything');
    expect(sent).toBe(false);
  });

  test('cancelling a waiting task resolves the waiting promise with cancellation', async () => {
    const runner = new TaskRunner();
    const agentState = createMockAgentState();

    const task = runner.submitTask(agentState, 'check config');
    const promise = runner.waitForInput(task.id, 'Which config file?');

    // Cancel the task
    const cancelled = runner.cancelTask(task.id);
    expect(cancelled).toBe(true);

    // The promise should resolve with cancellation message
    const result = await promise;
    expect(result).toContain('cancelled');

    // Task status should be cancelled
    const updated = runner.getTask(task.id);
    expect(updated?.status).toBe('cancelled');
    expect(updated?.waitingForInput).toBe(false);
  });

  test('stores messages after task execution', async () => {
    const runner = new TaskRunner();
    const agentState = createMockAgentState();

    const task = runner.submitTask(agentState, 'check logs');

    await new Promise(resolve => setTimeout(resolve, 50));

    const updated = runner.getTask(task.id);
    expect(updated?.messages).toBeDefined();
    expect(updated?.messages.length).toBeGreaterThanOrEqual(2); // system + user at minimum
  });

  test('emits structured events during task lifecycle', async () => {
    const runner = new TaskRunner();
    const agentState = createMockAgentState();

    const statusEvents: any[] = [];
    const logEvents: any[] = [];

    runner.on('task:status', (data) => statusEvents.push(data));
    runner.on('task:log', (data) => logEvents.push(data));

    runner.submitTask(agentState, 'run diagnostics');

    await new Promise(resolve => setTimeout(resolve, 50));

    // Should have at least running and completed status events
    expect(statusEvents.length).toBeGreaterThanOrEqual(2);
    expect(statusEvents.some((e) => e.status === 'running')).toBe(true);
    expect(statusEvents.some((e) => e.status === 'completed')).toBe(true);

    // Should have log events
    expect(logEvents.length).toBeGreaterThanOrEqual(1);
  });

  test('emits waiting event when task waits for input', () => {
    const runner = new TaskRunner();
    const agentState = createMockAgentState();

    const waitingFn = mock(() => {});

    runner.on('task:waiting', waitingFn);

    const task = runner.submitTask(agentState, 'check config');
    runner.waitForInput(task.id, 'Which file?');

    expect(waitingFn).toHaveBeenCalledTimes(1);
    expect(waitingFn).toHaveBeenCalledWith({
      taskId: task.id,
      prompt: 'Which file?',
    });
  });
});