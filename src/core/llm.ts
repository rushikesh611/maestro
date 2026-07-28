import type { LLMConfig, LLMResponse, Message, Tool } from "./types";

export class LLM {
    constructor(private config: LLMConfig) { }

    async chat(message: Message[], tools?: Tool[]): Promise<LLMResponse> {

        const toolDefs = tools?.map(t => ({
            type: 'function' as const,
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters
            }
        }))

        const headers: Record<string, any> = {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
        }
        if (this.config.siteUrl) headers['HTTP-Referer'] = this.config.siteUrl;
        if (this.config.siteName) headers['X-Title'] = this.config.siteName;

        const res = await fetch(`${this.config.baseURL || 'https://openrouter.ai/api/v1'}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: this.config.model,
                message,
                temperature: 0.2,
                tools: toolDefs
            })
        })

        if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`)
        const data: any = await res.json();
        const choice = data.choices[0].message;

        return {
            content: choice.content,
            tool_calls: choice.tool_calls,
        }
    }
}