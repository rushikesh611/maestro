import { describe, expect, test, mock } from 'bun:test';
import { reflectAndStoreLearnings } from '../../src/core/reflection';
import type { LLM, Memory, MemoryEntry } from '../../src/core/types';

describe('Async Reflection & Learning Memory (Task 3.2)', () => {
  test('extracts learning and saves to memory on valid task result', async () => {
    const mockAdd = mock(async () => {});
    const mockMemory: Memory = {
      add: mockAdd,
      search: async () => [],
      getRecent: async () => [],
      getLearnings: async () => [],
      getRelevantContext: async () => [],
    };

    const mockLLM: LLM = {
      chat: mock(async () => ({
        content: '[Symptom] OOMKilled in web pod -> [Fix] Increase memory limit to 512Mi',
        tool_calls: undefined,
      })),
    };

    await reflectAndStoreLearnings(
      mockLLM,
      mockMemory,
      'agent-1',
      'Fix web pod OOMKilled crash',
      'Increased memory limit in deployment.yaml',
    );

    expect(mockAdd).toHaveBeenCalledTimes(1);
    const addedEntry = (mockAdd.mock.calls[0] as any[])[0] as Omit<MemoryEntry, 'id' | 'created_at'>;
    expect(addedEntry.agent_id).toBe('agent-1');
    expect(addedEntry.type).toBe('learning');
    expect(addedEntry.content).toContain('OOMKilled');
  });

  test('does not save memory entry when LLM returns NONE', async () => {
    const mockAdd = mock(async () => {});
    const mockMemory: Memory = {
      add: mockAdd,
      search: async () => [],
      getRecent: async () => [],
      getLearnings: async () => [],
      getRelevantContext: async () => [],
    };

    const mockLLM: LLM = {
      chat: mock(async () => ({
        content: 'NONE',
        tool_calls: undefined,
      })),
    };

    await reflectAndStoreLearnings(
      mockLLM,
      mockMemory,
      'agent-1',
      'Check current date',
      'Today is 2026-08-06',
    );

    expect(mockAdd).toHaveBeenCalledTimes(0);
  });

  test('handles LLM error gracefully without throwing', async () => {
    const mockMemory: Memory = {
      add: mock(async () => {}),
      search: async () => [],
      getRecent: async () => [],
      getLearnings: async () => [],
      getRelevantContext: async () => [],
    };

    const failingLLM: LLM = {
      chat: mock(async () => {
        throw new Error('LLM rate limit exceeded');
      }),
    };

    // Should resolve cleanly without throwing
    await expect(
      reflectAndStoreLearnings(
        failingLLM,
        mockMemory,
        'agent-1',
        'Inspect logs',
        'Found error',
      ),
    ).resolves.toBeUndefined();
  });
});
