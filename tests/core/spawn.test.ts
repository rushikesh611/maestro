import { describe, expect, test } from 'bun:test';
import { spawnAgent } from '../../src/core/spawn';
import { TaskRunner } from '../../src/core/task-runner';
import type { AgentDef, LLM, Memory } from '../../src/core/types';

const agentDefs: AgentDef[] = [
  { name: 'k8s-expert', description: 'Kubernetes specialist', systemPrompt: 'You are a K8s expert.' },
  { name: 'linux-expert', description: 'Linux specialist', systemPrompt: 'You are a Linux expert.' },
];

function createMockMemory(): Memory {
  return {
    add: async () => {},
    search: async () => [],
    getRecent: async () => [],
    getLearnings: async () => [],
    getRelevantContext: async () => [],
  };
}

function createMockLLM(): LLM {
  return {
    chat: async () => ({ content: 'task finished', tool_calls: undefined }),
  };
}

describe('spawnAgent (manual assignment helper)', () => {
  test('runs the named agent synchronously and returns its output', async () => {
    const result = await spawnAgent({
      agentName: 'k8s-expert',
      task: 'inspect the cluster',
      agentDefs,
      allTools: [],
      llm: createMockLLM(),
      memory: createMockMemory(),
      skills: [],
    });

    expect(result).toContain('--- k8s-expert output ---');
    expect(result).toContain('task finished');
  });

  test('returns a helpful error when the agent name is unknown', async () => {
    const result = await spawnAgent({
      agentName: 'does-not-exist',
      task: 'anything',
      agentDefs,
      allTools: [],
      llm: createMockLLM(),
      memory: createMockMemory(),
      skills: [],
    });

    expect(result).toContain('not found');
    expect(result).toContain('k8s-expert');
    expect(result).toContain('linux-expert');
  });

  test('lists available agents when none match', async () => {
    const result = await spawnAgent({
      agentName: 'nope',
      task: 'x',
      agentDefs: [],
      allTools: [],
      llm: createMockLLM(),
      memory: createMockMemory(),
      skills: [],
    });

    expect(result).toContain('(none loaded)');
  });

  test('dispatches to background and returns a task id when async is true', async () => {
    const taskRunner = new TaskRunner();
    const result = await spawnAgent({
      agentName: 'linux-expert',
      task: 'watch logs',
      async: true,
      agentDefs,
      allTools: [],
      llm: createMockLLM(),
      memory: createMockMemory(),
      skills: [],
      taskRunner,
    });

    expect(result).toContain('background with Task ID:');
    expect(taskRunner.listTasks()).toHaveLength(1);
    expect(taskRunner.listTasks()[0]?.agentName).toBe('linux-expert');
  });
});

describe('tag pattern (@agent-name)', () => {
  const TAG_PATTERN = /^@([\w.-]+)(?:\/(bg|async))?\s+(.+)$/;

  function match(input: string) {
    const m = input.match(TAG_PATTERN);
    if (!m) return null;
    return { agent: m[1]!, flag: m[2] ?? null, task: m[3]! };
  }

  test('parses @agent-name task', () => {
    const r = match('@k8s-expert check the pod logs');
    expect(r).not.toBeNull();
    expect(r!.agent).toBe('k8s-expert');
    expect(r!.flag).toBeNull();
    expect(r!.task).toBe('check the pod logs');
  });

  test('parses @agent-name/bg task with background flag', () => {
    const r = match('@linux-expert/bg monitor cpu');
    expect(r).not.toBeNull();
    expect(r!.agent).toBe('linux-expert');
    expect(r!.flag).toBe('bg');
    expect(r!.task).toBe('monitor cpu');
  });

  test('parses @agent-name/async task', () => {
    const r = match('@sre/async check cluster');
    expect(r).not.toBeNull();
    expect(r!.agent).toBe('sre');
    expect(r!.flag).toBe('async');
    expect(r!.task).toBe('check cluster');
  });

  test('rejects plain input without @tag', () => {
    expect(match('just a normal prompt')).toBeNull();
  });

  test('rejects @tag without task', () => {
    expect(match('@k8s-expert')).toBeNull();
  });

  test('handles multi-word agent names with dots', () => {
    const r = match('@my.agent run deploy');
    expect(r).not.toBeNull();
    expect(r!.agent).toBe('my.agent');
    expect(r!.task).toBe('run deploy');
  });
});