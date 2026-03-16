/**
 * Squad MCP Server
 *
 * Exposes Squad's custom tools (squad_decide, squad_memory, squad_skill,
 * squad_route, squad_status) as an MCP server over stdio.
 *
 * Claude Code sessions connect to this via --mcp-config, giving agents
 * native access to Squad's orchestration primitives.
 *
 * Usage:
 *   SQUAD_ROOT=/path/to/project node squad-mcp-server.js
 *
 * @module tools/mcp-server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ToolRegistry } from './index.js';

const squadRoot = process.env['SQUAD_ROOT'] ?? process.cwd();

const registry = new ToolRegistry(squadRoot);
const tools = registry.getTools();

const server = new Server(
  { name: 'squad-tools', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(t => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: (t.parameters && 'type' in t.parameters)
      ? t.parameters as Record<string, unknown>
      : { type: 'object' as const, properties: {} },
  })),
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = registry.getTool(name);

  if (!tool) {
    return {
      content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    const raw = await tool.handler(args ?? {}, {
      sessionId: 'mcp',
      toolCallId: `mcp-${Date.now()}`,
      toolName: name,
      arguments: args ?? {},
    });

    // Map SquadToolResult to MCP response
    if (typeof raw === 'string') {
      return { content: [{ type: 'text' as const, text: raw }] };
    }

    const result = raw as { textResultForLlm: string; resultType: string };
    const isError = result.resultType === 'failure' || result.resultType === 'rejected';
    return {
      content: [{ type: 'text' as const, text: result.textResultForLlm }],
      isError,
    };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Tool error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
