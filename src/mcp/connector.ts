import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '../core/types';

function createClient(): Client {
    return new Client({ name: 'sre-agent', version: '1.0.0' });
}

export async function connectMCP(target: string, args: string[]): Promise<{ tools: Tool[]; close: () => Promise<void> }> {
    let transport: any;
    let client: Client;

    const isHttpTarget = /^https?:\/\//i.test(target);

    if (isHttpTarget) {
        const url = new URL(target);
        const streamableClient = createClient();
        try {
            const streamableTransport = new StreamableHTTPClientTransport(url);
            await streamableClient.connect(streamableTransport);
            transport = streamableTransport;
            client = streamableClient;
        } catch (error) {
            const sseClient = createClient();
            const sseTransport = new SSEClientTransport(url);
            await sseClient.connect(sseTransport);
            transport = sseTransport;
            client = sseClient;
        }
    } else {
        transport = new StdioClientTransport({ command: target, args });
        client = createClient();
        await client.connect(transport);
    }

    const { tools } = await client.listTools();

    const mappedTools: Tool[] = tools.map((tool: any) => ({
        name: `mcp_${tool.name}`,
        description: tool.description || `MCP: ${tool.name}`,
        parameters: tool.inputSchema || { type: 'object', properties: {} },
        handler: async (args: any, _ctx: any) => {
            const result = await client.callTool({ name: tool.name, arguments: args });
            return JSON.stringify(result.content);
        },
        risk: 'mutate' as const,
    }));

    return {
        tools: mappedTools,
        close: async () => {
            try {
                await transport.close();
            } catch {
                // ignore transport close errors
            }
            try {
                await client.close();
            } catch {
                // ignore client close errors
            }
        },
    };
}