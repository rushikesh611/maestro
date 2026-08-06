import { describe, expect, test, beforeEach } from 'bun:test';
import { createMemory, sanitizeFts5 } from '../../src/core/memory';
import type { Memory } from '../../src/core/types';

describe('Log-Aware Memory & Search (Task 3.1)', () => {
  describe('sanitizeFts5', () => {
    test('wraps tokens containing SRE punctuation in phrase quotes', () => {
      expect(sanitizeFts5('192.168.1.1')).toBe('"192.168.1.1"');
      expect(sanitizeFts5('pod/web-79f8b4-x9z')).toBe('"pod/web-79f8b4-x9z"');
      expect(sanitizeFts5('HTTP/500 internal server error')).toBe('"HTTP/500" internal server error');
    });

    test('escapes internal quotes and reserved FTS keywords', () => {
      expect(sanitizeFts5('error "connection reset" AND timeout')).toBe('error """connection" "reset""" "AND" timeout');
    });

    test('handles empty or whitespace query', () => {
      expect(sanitizeFts5('')).toBe('nullquery');
      expect(sanitizeFts5('   ')).toBe('nullquery');
    });
  });

  describe('LibSQL Memory Operations', () => {
    let memory: Memory;

    beforeEach(async () => {
      // Create in-memory LibSQL database instance
      memory = await createMemory('file::memory:');
    });

    test('stores and retrieves IP address log entries accurately', async () => {
      await memory.add({
        agent_id: 'test-agent',
        type: 'conversation',
        content: 'Incoming request from IP 192.168.1.1 failed authentication',
      });

      const results = await memory.search('test-agent', '192.168.1.1');
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toContain('192.168.1.1');
    });

    test('stores and retrieves pod names with hyphens and slashes', async () => {
      await memory.add({
        agent_id: 'sre-agent',
        type: 'fact',
        content: 'Pod pod/web-app-79f8b4-k2x crashed due to OOMKilled in prod namespace',
      });

      const results = await memory.search('sre-agent', 'pod/web-app-79f8b4-k2x');
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toContain('OOMKilled');
    });

    test('falls back to LIKE search if exact phrase match is requested', async () => {
      await memory.add({
        agent_id: 'sre-agent',
        type: 'learning',
        content: 'Fix for error_code_500: restart redis deployment',
      });

      const results = await memory.search('sre-agent', 'error_code_500');
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toContain('restart redis deployment');
    });
  });
});
