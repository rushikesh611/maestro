import type { LLM, Memory } from './types';

/**
 * Asynchronously extracts operational SRE learnings from a completed task and stores them in memory.
 * Runs in background without blocking response delivery to the user.
 */
export async function reflectAndStoreLearnings(
  llm: LLM,
  memory: Memory,
  agentId: string,
  task: string,
  result: string,
): Promise<void> {
  if (!result || result === '(no response)' || result === 'Max iterations reached.') {
    return;
  }

  const prompt = `Task: ${task}\nResult: ${result}\n\nAnalyze this completed SRE task. If a bug, incident, or configuration issue was resolved or investigated, extract 1-2 concise operational learnings (e.g. "[Symptom] ... -> [Fix] ..."). If nothing novel or actionable was learned, reply strictly NONE.`;

  try {
    const res = await llm.chat([
      {
        role: 'system',
        content: 'You extract concise operational SRE learnings and incident solutions for future retrieval.',
      },
      { role: 'user', content: prompt },
    ]);

    const content = res.content?.trim();
    if (content && content.toUpperCase() !== 'NONE') {
      await memory.add({
        agent_id: agentId,
        type: 'learning',
        content,
        metadata: JSON.stringify({ task: task.slice(0, 200), timestamp: Date.now() }),
      });
    }
  } catch {
    // Non-blocking best-effort execution
  }
}
