import type { Message, LLM } from './types';

/**
 * Configuration for the sliding context window.
 * threshold: number of non-system messages to accumulate before compressing older turns.
 * keepRecent: number of most recent non-system messages to always keep verbatim.
 */
export interface WindowOptions {
  threshold?: number;
  keepRecent?: number;
}

/**
 * Estimates rough token count as character_count / 4.
 * Gives a cheap heuristic without a full tokenizer dependency.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Counts total estimated tokens across all messages in a conversation.
 */
export function totalMessageTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : '';
    return sum + estimateTokens(content);
  }, 0);
}

/**
 * Applies a sliding context window to the message array.
 *
 * When the non-system messages exceed `threshold`, the older turns (everything
 * except the last `keepRecent`) are removed from the array and replaced with a
 * compact summary block injected as a system message.
 *
 * If the LLM is provided, the summary is generated via a cheap LLM call.
 * Otherwise a lightweight text-only summary is produced from the messages.
 */
export async function applyContextWindow(
  messages: Message[],
  llm?: LLM,
  opts?: WindowOptions,
): Promise<Message[]> {
  const threshold = opts?.threshold ?? 10;
  const keepRecent = opts?.keepRecent ?? 6;

  const systemMsg = messages.find(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  // No compression needed yet
  if (nonSystem.length <= threshold) return messages;

  const toCompress = nonSystem.slice(0, nonSystem.length - keepRecent);
  const toKeep = nonSystem.slice(nonSystem.length - keepRecent);

  const summary = await summarizeMessages(toCompress, llm);

  const summaryMsg: Message = {
    role: 'system',
    content: `[Compressed context — earlier conversation summary]\n${summary}`,
  };

  return [
    ...(systemMsg ? [systemMsg] : []),
    summaryMsg,
    ...toKeep,
  ];
}

/**
 * Summarizes a list of messages into a compact text block.
 * Uses LLM when available; falls back to text extraction.
 */
async function summarizeMessages(messages: Message[], llm?: LLM): Promise<string> {
  if (!messages.length) return '';

  if (llm) {
    try {
      const transcript = formatTranscript(messages);
      const res = await llm.chat([
        {
          role: 'system',
          content:
            'You are a context compressor. Summarize the following SRE conversation transcript concisely (max 300 words). Preserve key findings, tool results, error messages, resource names, and decisions made. Omit pleasantries and repetition.',
        },
        { role: 'user', content: transcript },
      ]);
      if (res.content) return res.content.trim();
    } catch {
      // Fall through to text-only summary on LLM failure
    }
  }

  // Fallback: lightweight text extraction (no LLM cost)
  return formatTranscript(messages).slice(0, 1500) + '\n...[further context truncated]';
}

/**
 * Formats a list of messages into a readable transcript string.
 */
function formatTranscript(messages: Message[]): string {
  return messages
    .map(m => {
      const role = m.role === 'tool' ? `tool(${m.name ?? 'unknown'})` : m.role;
      const content = (m.content ?? '').slice(0, 500);
      return `[${role}]: ${content}`;
    })
    .join('\n');
}
