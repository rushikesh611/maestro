import type { Message, Tool, LLMConfig, LLMResponse } from './types';

const MAX_RETRIES = 2;
const TIMEOUT_MS = 120_000; // 2 min for testing — OpenRouter free tier needs this

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function createLLM(config: LLMConfig): import('./types').LLM {
  let reqId = 0;

  return {
    async chat(messages, tools?) {
      const id = ++reqId;
      const toolDefs = tools?.map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));

      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      };
      if (config.siteUrl) headers['HTTP-Referer'] = config.siteUrl;
      if (config.siteName) headers['X-Title'] = config.siteName;

      // Mark system messages with cache_control so providers (Anthropic, OpenRouter)
      // can serve them from cache on subsequent turns — reduces cost by up to 80%.
      const cachedMessages = messages.map(m => {
        if (m.role === 'system') {
          return { ...m, cache_control: { type: 'ephemeral' as const } };
        }
        return m;
      });

      const body = JSON.stringify({
        model: config.model,
        messages: cachedMessages,
        temperature: 0.2,
        tools: toolDefs,
      });

      let lastError: Error | null = null;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const res = await fetchWithTimeout(
            `${config.baseURL || 'https://openrouter.ai/api/v1'}/chat/completions`,
            { method: 'POST', headers, body },
            TIMEOUT_MS,
          );

          const rawText = await res.text();
          let data: any;

          try {
            data = JSON.parse(rawText);
          } catch {
            throw new Error(`Non-JSON response (HTTP ${res.status}): ${rawText.slice(0, 500)}`);
          }

          if (data.error) {
            const errMsg = data.error.message || JSON.stringify(data.error);
            throw new Error(`OpenRouter error: ${errMsg}`);
          }

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 500)}`);
          }

          if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
            throw new Error(`No choices in response: ${rawText.slice(0, 500)}`);
          }

          const choice = data.choices[0].message;
          if (!choice) {
            throw new Error(`Empty choice[0].message: ${rawText.slice(0, 500)}`);
          }

          // Extract token usage from OpenRouter response
          const usage = data.usage;

          return {
            content: choice.content ?? null,
            tool_calls: choice.tool_calls,
            usage: usage ? {
              prompt_tokens: usage.prompt_tokens,
              completion_tokens: usage.completion_tokens,
              total_tokens: usage.total_tokens,
            } : undefined,
          };

        } catch (err: any) {
          lastError = err;

          if (err.message?.includes('401') || err.message?.includes('403')) {
            throw err;
          }

          if (err.name === 'AbortError') {
            lastError = new Error(`[req ${id}] timed out after ${TIMEOUT_MS}ms`);
          }

          const isLastAttempt = attempt === MAX_RETRIES - 1;
          if (isLastAttempt) break;

          const delay = Math.min(1000 * 2 ** attempt, 8000);
          // Log retries to stderr so they don't pollute stdout / mix with results
          console.error(`\x1b[90m⏳ [req ${id}] attempt ${attempt + 1}/${MAX_RETRIES} failed: ${err.message}. retry in ${delay}ms\x1b[0m`);
          await sleep(delay);
        }
      }

      throw lastError || new Error(`[req ${id}] failed after ${MAX_RETRIES} retries`);
    },
  };
}