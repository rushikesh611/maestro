import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '../core/types';

export async function connectMCP(command: string, args: string[]): Promise<{ tools: Tool[]; close: () => Promise<void> }> {
    const transport = new StdioClientTransport({ command, args });
    const client = new Client({ name: 'sre-agent', version: '1.0.0' });
    await client.connect(transport);

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
            await transport.close();
            await client.close();
        },
    };
}