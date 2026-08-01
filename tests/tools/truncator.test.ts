import { describe, expect, test } from 'bun:test';
import { truncateOutput } from '../../src/tools/truncator';

describe('Tool Output Truncator (Task 2.1)', () => {
  test('returns short outputs untouched', () => {
    const text = 'Line 1\nLine 2\nLine 3';
    expect(truncateOutput(text)).toBe(text);
  });

  test('truncates line-heavy outputs (>100 lines) preserving head (first 20) and tail (last 80)', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`);
    const input = lines.join('\n');

    const result = truncateOutput(input);
    const resultLines = result.split('\n');

    expect(result).toContain('... [100 lines truncated to save context] ...');
    expect(resultLines[0]).toBe('Line 1');
    expect(resultLines[19]).toBe('Line 20');
    expect(resultLines[resultLines.length - 1]).toBe('Line 200');
    expect(resultLines[resultLines.length - 80]).toBe('Line 121');
  });

  test('truncates character-heavy single-line outputs', () => {
    const input = 'A'.repeat(5000);
    const result = truncateOutput(input, { maxChars: 1000 });

    expect(result).toContain('characters truncated to save context');
    expect(result.length).toBeLessThan(5000);
    expect(result.startsWith('A'.repeat(200))).toBe(true);
    expect(result.endsWith('A'.repeat(800))).toBe(true);
  });
});
