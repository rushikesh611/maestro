import { describe, expect, test, mock } from 'bun:test';
import {
  applyContextWindow,
  estimateTokens,
  totalMessageTokens,
} from '../../src/core/context-window';
import type { Message, LLM } from '../../src/core/types';

function makeMessages(count: number): Message[] {
  const msgs: Message[] = [{ role: 'system', content: 'You are an SRE agent.' }];
  for (let i = 0; i < count; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Turn ${i + 1} message` });
  }
  return msgs;
}

describe('Context Window & Sliding (Task 2.3)', () => {
  test('estimateTokens returns ceiling of char_count / 4', () => {
    expect(estimateTokens('hello')).toBe(2);      // 5 / 4 = 1.25 → 2
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  test('totalMessageTokens sums all message content estimates', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'a'.repeat(400) },
      { role: 'user', content: 'b'.repeat(200) },
    ];
    expect(totalMessageTokens(msgs)).toBe(150); // 100 + 50
  });

  test('does not compress when under threshold', async () => {
    const msgs = makeMessages(8); // 8 non-system messages, threshold=10
    const result = await applyContextWindow(msgs, undefined, { threshold: 10, keepRecent: 6 });
    expect(result).toHaveLength(msgs.length); // unchanged
  });

  test('compresses older turns and keeps recent ones when above threshold', async () => {
    const msgs = makeMessages(14); // 14 non-system + 1 system = 15 total
    const result = await applyContextWindow(msgs, undefined, { threshold: 10, keepRecent: 6 });

    // Result: system + summary_system + 6 recent
    expect(result[0]!.role).toBe('system');
    expect(result[0]!.content).toBe('You are an SRE agent.');

    // Second message should be the compressed summary
    expect(result[1]!.role).toBe('system');
    expect(result[1]!.content).toContain('[Compressed context');

    // Total: system + summaryMsg + 6 recent = 8
    expect(result).toHaveLength(8);

    // Last 6 non-system messages are preserved verbatim
    const tail = result.slice(2);
    expect(tail[0]!.content).toBe('Turn 9 message');
    expect(tail[tail.length - 1]!.content).toBe('Turn 14 message');
  });

  test('uses LLM to produce richer summary when provided', async () => {
    const msgs = makeMessages(12);

    const mockLLM: LLM = {
      chat: mock(async () => ({
        content: 'Mock LLM summary: pods were restarting, OOM kill confirmed.',
        tool_calls: undefined,
      })),
    };

    const result = await applyContextWindow(msgs, mockLLM, { threshold: 10, keepRecent: 6 });
    const summaryMsg = result.find(m => m.content?.includes('[Compressed context'));

    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.content).toContain('Mock LLM summary');
  });

  test('falls back to text extraction when LLM errors', async () => {
    const msgs = makeMessages(12);

    const failingLLM: LLM = {
      chat: mock(async () => { throw new Error('LLM unavailable'); }),
    };

    // Should not throw — falls back to text-only summary
    const result = await applyContextWindow(msgs, failingLLM, { threshold: 10, keepRecent: 6 });
    const summaryMsg = result.find(m => m.content?.includes('[Compressed context'));
    expect(summaryMsg).toBeDefined();
  });
});
