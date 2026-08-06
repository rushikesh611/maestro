import * as readline from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createLLM } from './core/llm';
import { createMemory } from './core/memory';
import { createAgentState, runAgent } from './core/agent';
import { loadSkills, loadAgents, loadPluginResources } from './core/loader';
import { execTool, readFileTool, writeFileTool, webFetchTool, thinkTool, createSpawnTool } from './tools/built-in';
import { k8sTools, dockerTools, linuxTools } from './tools/sre';
import { connectMCP } from './mcp/connector';
import { isAutoApprovable } from './tools/security';
import { TaskRunner } from './core/task-runner';
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
let approvalHandler: ((tool: string, args: any, risk: string) => Promise<boolean>) | null = null;
const taskRunner = new TaskRunner();

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
    const pluginResources = await loadPluginResources({ workspaceRoot: process.cwd(), homeDir: process.env.HOME || process.env.USERPROFILE });
    const pluginSkills = pluginResources.skills;
    const pluginAgents = pluginResources.agents;
    const pluginTools = pluginResources.tools;
    const sreDef = agentDefs.find(a => a.name === 'sre');

    const baseTools: Tool[] = [execTool, readFileTool, writeFileTool, webFetchTool, thinkTool];
    const allTools: Tool[] = [...baseTools, ...k8sTools, ...dockerTools, ...linuxTools, ...pluginTools];

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

    allTools.push(createSpawnTool([...agentDefs, ...pluginAgents], allTools));

    approvalHandler = async (tool: string, args: any, risk: string): Promise<boolean> => {
        // Auto-approve: read-only kubectl/docker/helm subcommands ONLY (AST-validated, no operators)
        if (isAutoApprovable(tool, args)) {
          return true;
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
        skills: [...skills, ...pluginSkills],
        maxIterations: 50,
        onApprove: approvalHandler || undefined,
    });

    console.log('🚀 SRE Agent ready.');
    console.log(`   Skills: ${skills.length + pluginSkills.length} | Agents: ${agentDefs.length + pluginAgents.length} | Tools: ${allTools.length}`);
    if (pluginResources.plugins.length) {
        console.log(`   Plugins: ${pluginResources.plugins.map(p => p.name).join(', ')}`);
    }
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

        // Slash command router
        if (trimmed.startsWith('/')) {
          const [cmd, ...args] = trimmed.split(/\s+/);
          const subArg = args.join(' ');

          if (cmd === '/bg' || cmd === '/submit') {
            if (!subArg) {
              console.log(' Usage: /bg <task prompt>\n');
              continue;
            }
            const task = taskRunner.submitTask(currentState, subArg);
            console.log(`\n🚀 Background task submitted: [${task.id}]\n`);
            continue;
          }

          if (cmd === '/tasks' || cmd === '/jobs') {
            const tasks = taskRunner.listTasks();
            if (tasks.length === 0) {
              console.log('\n📋 No background tasks recorded.\n');
              continue;
            }
            console.log('\n📋 Background Tasks:');
            for (const t of tasks) {
              const dur = t.completedAt ? `${((t.completedAt - t.createdAt) / 1000).toFixed(1)}s` : 'running...';
              console.log(`  [${t.id}] ${t.status.toUpperCase()} | ${t.taskPrompt.slice(0, 40)} | Duration: ${dur}`);
            }
            console.log('');
            continue;
          }

          if (cmd === '/view' || cmd === '/attach') {
            if (!subArg) {
              console.log(' Usage: /view <task-id>\n');
              continue;
            }
            const task = taskRunner.getTask(subArg);
            if (!task) {
              console.log(`❌ Task [${subArg}] not found.\n`);
              continue;
            }
            console.log(`\n📋 Task [${task.id}] Status: ${task.status.toUpperCase()}`);
            console.log(`   Prompt: ${task.taskPrompt}`);
            if (task.result) console.log(`\nResult:\n${task.result}\n`);
            if (task.error) console.log(`\nError:\n${task.error}\n`);
            continue;
          }

          if (cmd === '/cancel') {
            if (!subArg) {
              console.log(' Usage: /cancel <task-id>\n');
              continue;
            }
            const ok = taskRunner.cancelTask(subArg);
            if (ok) {
              console.log(`\n🛑 Task [${subArg}] cancelled.\n`);
            } else {
              console.log(`❌ Could not cancel task [${subArg}].\n`);
            }
            continue;
          }

          if (cmd === '/reload') {
            try {
              const pluginResources = await loadPluginResources({ workspaceRoot: process.cwd(), homeDir: process.env.HOME || process.env.USERPROFILE });
              const freshSkills = [...(await loadSkills(join(__dirname, 'skills'))), ...pluginResources.skills];
              const freshAgentDefs = [...(await loadAgents(join(__dirname, 'agents'))), ...pluginResources.agents];
              const freshTools = [...[execTool, readFileTool, writeFileTool, webFetchTool, thinkTool], ...k8sTools, ...dockerTools, ...linuxTools, ...pluginResources.tools];
              currentState = createAgentState({
                id: currentState?.id || 'main',
                name: currentState?.name || 'sre-agent',
                systemPrompt: freshAgentDefs.find(a => a.name === 'sre')?.systemPrompt || currentState?.systemPrompt || 'You are an SRE agent.',
                tools: freshTools,
                llm: currentState?.llm || createLLM({ apiKey: LLM_API_KEY, model: LLM_MODEL, baseURL: LLM_BASE_URL, siteUrl: SITE_URL, siteName: SITE_NAME }),
                memory: currentState?.memory || await createMemory(TURSO_URL, TURSO_TOKEN),
                skills: freshSkills,
                maxIterations: currentState?.maxIterations ?? 50,
                workingDir: currentState?.workingDir,
                parentId: currentState?.parentId,
                onApprove: approvalHandler || undefined,
                taskRunner,
              });
              console.log(`\n♻️ Reloaded plugins: ${pluginResources.plugins.length ? pluginResources.plugins.map(p => p.name).join(', ') : 'none'}\n`);
              continue;
            } catch (e: any) {
              console.log(`\n❌ Reload failed: ${e.message}\n`);
              continue;
            }
          }

          if (cmd === '/help') {
            console.log('\n💡 Maestro Commands:');
            console.log('   /bg <prompt>      - Run task in background');
            console.log('   /tasks            - List background tasks');
            console.log('   /view <task-id>   - View task result/status');
            console.log('   /cancel <task-id> - Cancel background task');
            console.log('   /reload           - Reload plugins and tool definitions');
            console.log('   exit              - Exit Maestro\n');
            continue;
          }
        }

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