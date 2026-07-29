import * as readline from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createLLM } from './core/llm';
import { createMemory } from './core/memory';
import { createAgentState, runAgent } from './core/agent';
import { loadSkills, loadAgents } from './core/loader';
import { execTool, readFileTool, writeFileTool, webFetchTool, thinkTool, createSpawnTool } from './tools/built-in';
import { k8sTools, dockerTools, linuxTools } from './tools/sre';
import { connectMCP } from './mcp/connector';
import type { Tool, AgentState } from './core/types';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TURSO_URL = process.env.TURSO_URL || 'file:./memory/sre.db';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'openai/gpt-4o-mini';
const LLM_BASE_URL = process.env.LLM_BASE_URL;
const SITE_URL = process.env.SITE_URL || 'http://localhost';
const SITE_NAME = process.env.SITE_NAME || 'SRE Agent';
const MCP_COMMAND = process.env.MCP_COMMAND;
const AUTO_APPROVE = process.env.AUTO_APPROVE?.split(',') || [];

let currentState: AgentState | null = null;
let mcpCleanup: (() => Promise<void>) | null = null;

async function main() {
    if (!LLM_API_KEY) {
        console.error('❌ LLM_API_KEY is required. Set it in .env');
        process.exit(1);
    }

    const memory = await createMemory(TURSO_URL, TURSO_TOKEN);
    const llm = createLLM({
        apiKey: LLM_API_KEY,
        model: LLM_MODEL,
        baseURL: LLM_BASE_URL,
        siteUrl: SITE_URL,
        siteName: SITE_NAME,
    });

    const skills = await loadSkills(join(__dirname, 'skills'));
    const agentDefs = await loadAgents(join(__dirname, 'agents'));
    const sreDef = agentDefs.find(a => a.name === 'sre');

    const baseTools: Tool[] = [execTool, readFileTool, writeFileTool, webFetchTool, thinkTool];
    const allTools: Tool[] = [...baseTools, ...k8sTools, ...dockerTools, ...linuxTools];

    if (MCP_COMMAND) {
        try {
            const mcpArgs = process.env.MCP_ARGS?.split(' ') || [];
            const mcp = await connectMCP(MCP_COMMAND, mcpArgs);
            allTools.push(...mcp.tools);
            mcpCleanup = mcp.close;
            console.log(`🔗 MCP connected: ${mcp.tools.length} tools`);
        } catch (e: any) {
            console.warn(`⚠️ MCP failed: ${e.message}`);
        }
    }

    allTools.push(createSpawnTool(agentDefs, allTools));

    const onApprove = async (tool: string, args: any, risk: string): Promise<boolean> => {
        // Auto-approve: read-only kubectl/docker/helm subcommands ONLY
        if (tool === 'kubectl' || tool === 'docker' || tool === 'helm') {
          const cmd = (args.command || '') as string;
          const readVerbs = ['get', 'describe', 'logs', 'top', 'status', 'list', 'inspect', 'ps', 'images', 'stats'];
          const verb = cmd.trim().split(/\s+/)[0] ?? '';
          if (readVerbs.includes(verb)) return true;
        }
      
        // NEVER auto-approve exec — redirections (cat > file, echo > file) bypass word-level checks
      
        if (AUTO_APPROVE.includes(risk) || AUTO_APPROVE.includes('all')) return true;
      
        console.log(`\n\x1b[41m\x1b[37m 🔒 APPROVAL REQUIRED \x1b[0m`);
        console.log(`\x1b[33m   Tool:\x1b[0m  ${tool}`);
        console.log(`\x1b[33m   Risk:\x1b[0m  ${risk.toUpperCase()}`);
        console.log(`\x1b[33m   Args:\x1b[0m  ${JSON.stringify(args)}`);
        console.log(`\x1b[90m   Type 'y' and press Enter to approve. Anything else denies.\x1b[0m\n`);
      
        const answer = await ask('   Approve? (y/n): ');
        return answer.trim().toLowerCase() === 'y';
      };

    currentState = createAgentState({
        id: 'main',
        name: 'sre-agent',
        systemPrompt: sreDef?.systemPrompt || 'You are an SRE agent.',
        tools: allTools,
        llm,
        memory,
        skills,
        maxIterations: 50,
        onApprove,
    });

    console.log('🚀 SRE Agent ready.');
    console.log(`   Skills: ${skills.length} | Agents: ${agentDefs.length} | Tools: ${allTools.length}`);
    console.log(`   LLM: ${LLM_MODEL} via OpenRouter`);
    console.log('   Type a task or "exit"\n');

    await runRepl();
    await shutdown();
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(q: string): Promise<string> {
    return new Promise(resolve => rl.question(q, resolve));
}

async function runRepl() {
    while (true) {
        const input = await ask('> ');
        const trimmed = input.trim();
        if (trimmed === 'exit' || trimmed === 'quit') break;
        if (!trimmed || !currentState) continue;

        console.log('\n🤔 Working...\n');
        try {
            const { result, state } = await runAgent(currentState, trimmed);
            currentState = state;
            console.log(`\n📋 Result:\n${result}\n`);
        } catch (e: any) {
            console.error(`\n❌ Error: ${e.message}\n`);
        }
    }
}

async function shutdown() {
    if (mcpCleanup) {
        await mcpCleanup();
        mcpCleanup = null;
    }
    rl.close();
}

process.on('SIGINT', () => shutdown().finally(() => process.exit(0)));
process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)));

main().catch(async (err) => {
    console.error(err);
    await shutdown();
    process.exit(1);
});