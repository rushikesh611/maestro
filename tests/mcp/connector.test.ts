import { describe, expect, test } from 'bun:test';
import { createServer } from 'http';
import { once } from 'events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod/v4';
import { connectMCP } from '../../src/mcp/connector';

describe('MCP SSE connector', () => {
  test('connects to an SSE endpoint and lists available tools', async () => {
    const transports = new Map<string, SSEServerTransport>();
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === '/sse') {
        const transport = new SSEServerTransport('/messages', res);
        transport.onclose = () => {
          transports.delete(transport.sessionId);
        };
        transports.set(transport.sessionId, transport);
        const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' });
        mcpServer.registerTool('echo', {
          description: 'Echo tool',
          inputSchema: { message: z.string() },
        }, async ({ message }) => ({
          content: [{ type: 'text', text: message }],
        }));
        await mcpServer.connect(transport);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/messages') {
        const sessionId = url.searchParams.get('sessionId');
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          res.writeHead(404);
          res.end('missing transport');
          return;
        }
        await transport.handlePostMessage(req, res, req.body);
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('invalid address');
    const url = `http://127.0.0.1:${address.port}/sse`;

    try {
      const result = await connectMCP(url, []);
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]?.name).toBe('mcp_echo');
      await result.close();
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
});
