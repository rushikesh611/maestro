export interface TruncateOptions {
  maxChars?: number;
  maxLines?: number;
  headLines?: number;
  tailLines?: number;
}

/**
 * Truncates output to fit within context window limits.
 * Preserves header context (first headLines) and recent error/log context (last tailLines).
 */
export function truncateOutput(output: string, opts?: TruncateOptions): string {
  if (!output || typeof output !== 'string') return output ?? '';

  const maxChars = opts?.maxChars ?? 2500;
  const maxLines = opts?.maxLines ?? 100;
  const headLines = opts?.headLines ?? 20;
  const tailLines = opts?.tailLines ?? 80;

  const lines = output.split(/\r?\n/);

  // Return unchanged if within limits
  if (output.length <= maxChars && lines.length <= maxLines) {
    return output;
  }

  // Line-based truncation
  if (lines.length > maxLines) {
    const head = lines.slice(0, headLines).join('\n');
    const tail = lines.slice(lines.length - tailLines).join('\n');
    const truncatedCount = lines.length - headLines - tailLines;
    return `${head}\n\n... [${truncatedCount} lines truncated to save context] ...\n\n${tail}`;
  }

  // Character-based truncation (for long single-line outputs)
  const headLength = Math.floor(maxChars * 0.2);
  const tailLength = Math.floor(maxChars * 0.8);
  const head = output.slice(0, headLength);
  const tail = output.slice(output.length - tailLength);
  const omittedChars = output.length - headLength - tailLength;

  return `${head}\n\n... [${omittedChars} characters truncated to save context] ...\n\n${tail}`;
}
