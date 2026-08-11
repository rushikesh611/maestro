import * as readline from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createLLM } from './core/llm';
import { createMemory } from './core/memory';
import { createAgentState, runAgent } from './core/agent';
import { spawnAgent } from './core/spawn';
import { loadSkills, loadAgents, loadPluginResources } from './core/loader';
import { execTool, readFileTool, writeFileTool, webFetchTool, thinkTool, waitForInputTool, createSpawnTool } from './tools/built-in';
import { k8sTools, dockerTools, linuxTools } from './tools/sre';
import { connectMCP } from './mcp/connector';
import { isAutoApprovable } from './tools/security';
import { TaskRunner, type TaskRecord } from './core/task-runner';
import type { Tool, AgentState, AgentDef } from './core/types';
import { TUI } from './tui/index';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TURSO_URL = process.env.TURSO_URL || 'file:./memory/sre.db';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'openai/gpt-4o-mini';
const LLM_BASE_URL = process.env.LLM_BASE_URL;
const SITE_URL = process.env.SITE_URL || 'https://github.com/rushikesh611/maestro';
const SITE_NAME = process.env.SITE_NAME || 'Maestro';
const MCP_COMMAND = process.env.MCP_COMMAND;
const AUTO_APPROVE = process.env.AUTO_APPROVE?.split(',') || [];

let currentState: AgentState | null = null;
let mcpCleanup: (() => Promise<void>) | null = null;
let approvalHandler: ((tool: string, args: any, risk: string) => Promise<boolean>) | null = null;
let agentDefsGlobal: AgentDef[] = [];
let allToolsGlobal: Tool[] = [];
let attachedTaskId: string | null = null;
const taskRunner = new TaskRunner();
const tui = new TUI();

// ─── Terminal / Readline Setup ──────────────────────────────────────────────
// Uses the TUI framework for full-screen terminal management.
// readline is only used for Ctrl+C handling and the initial prompt fallback.

const COMMANDS = [
  { name: '/bg', desc: '/bg <prompt>              Run task in background' },
  { name: '/tasks', desc: '/tasks                    List all background tasks' },
  { name: '/view', desc: '/view <id>                Show task conversation & result' },
  { name: '/attach', desc: '/attach <id>              Focus terminal on a bg task' },
  { name: '/detach', desc: '/detach                   Return to main agent' },
  { name: '/send', desc: '/send <id> <input>        Send input/approval to waiting task' },
  { name: '/cancel', desc: '/cancel <id>              Cancel a background task' },
  { name: '/agents', desc: '/agents                   List available agent presets' },
  { name: '/assign', desc: '/assign <agent> <task>    Run agent task in foreground' },
  { name: '/assign-bg', desc: '/assign-bg <agent> <task> Run agent task in background' },
  { name: '/reload', desc: '/reload                   Reload plugins without restart' },
  { name: '/help', desc: '/help                     Show all commands' },
];

// Wire up promptUser so wait_for_input tool uses the TUI's input handler
// (no second readline, no conflict)
taskRunner.promptUser = async (q: string) => {
  const result = await tui.promptUser(q);
  return result;
};

// ─── Ctrl+C: double-press to exit ────────────────────────────────────────────

let sigintCount = 0;
let sigintTimer: ReturnType<typeof setTimeout> | null = null;
let lastSigintMs = 0;

function handleSigint() {
  const now = Date.now();
  if (now - lastSigintMs < 150) return;
  lastSigintMs = now;

  sigintCount++;
  if (sigintCount === 1) {
    process.stdout.write(`\n\x1b[33m⚠️  Press Ctrl+C again within 2s to exit. Press Enter to keep going.\x1b[0m\n`);
    if (sigintTimer) clearTimeout(sigintTimer);
    sigintTimer = setTimeout(() => { sigintCount = 0; sigintTimer = null; }, 2000);
  } else {
    if (sigintTimer) clearTimeout(sigintTimer);
    shutdown().finally(() => process.exit(0));
  }
}

process.on('SIGINT', handleSigint);
process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)));

// ─── Background Task Notification Bus ────────────────────────────────────────

function bgTag(taskId: string, agentName: string): string {
  return `[bg:${taskId.slice(0, 6)} @${agentName}]`;
}

taskRunner.on('started', (task: TaskRecord) => {
  tui.appendOutput({ type: 'system', text: `${bgTag(task.id, task.agentName)} ▶ Started` });
});

taskRunner.on('completed', (task: TaskRecord) => {
  const dur = task.completedAt && task.startedAt
    ? ` (${((task.completedAt - task.startedAt) / 1000).toFixed(1)}s)`
    : '';
  tui.appendOutput({ type: 'system', text: `${bgTag(task.id, task.agentName)} ✓ Completed${dur} — /view ${task.id}` });
});

taskRunner.on('failed', (task: TaskRecord) => {
  const short = task.error?.slice(0, 80) ?? 'unknown error';
  tui.appendOutput({ type: 'error', text: `${bgTag(task.id, task.agentName)} ✗ Failed: ${short}` });
});

taskRunner.on('cancelled', (task: TaskRecord) => {
  tui.appendOutput({ type: 'system', text: `${bgTag(task.id, task.agentName)} ⊘ Cancelled` });
});

taskRunner.on('task:waiting', (data: { taskId: string; prompt: string }) => {
  const task = taskRunner.getTask(data.taskId);
  const name = task?.agentName ?? 'agent';
  tui.appendOutput({ type: 'system', text: `🔒 ACTION REQUIRED ${bgTag(data.taskId, name)}` });
  tui.appendOutput({ type: 'system', text: `   ${data.prompt}` });
  tui.appendOutput({ type: 'system', text: `   Approve: /send ${data.taskId} y    Deny: /send ${data.taskId} n` });
});

taskRunner.on('task:output', (data: { taskId: string; role: string; content: string }) => {
  if (attachedTaskId === data.taskId) {
    const prefix = data.role === 'assistant' ? '🤖' : data.role === 'tool' ? '⚡' : '📋';
    tui.appendOutput({ type: 'tool', text: `${prefix} ${data.content.slice(0, 300)}` });
  }
});

// ─── Per-task Approval Handler (for background agents) ───────────────────────

function createBgApprovalHandler(taskId: string) {
  return async (tool: string, args: any, risk: string): Promise<boolean> => {
    if (isAutoApprovable(tool, args)) return true;
    if (AUTO_APPROVE.includes(risk) || AUTO_APPROVE.includes('all')) return true;
    const question = `🔒 APPROVAL [${tool}] risk:${risk.toUpperCase()} args:${JSON.stringify(args).slice(0, 120)}`;
    const answer = await taskRunner.waitForInput(taskId, question);
    return answer.trim().toLowerCase() === 'y';
  };
}

// ─── Main Bootstrap ───────────────────────────────────────────────────────────

async function main() {
  if (!LLM_API_KEY) {
    console.error('❌ LLM_API_KEY is required. Set it in .env');
    process.exit(1);
  }

  const memory = await createMemory(TURSO_URL, TURSO_TOKEN);
  const llm = createLLM({
    apiKey: LLM_API_KEY, model: LLM_MODEL, baseURL: LLM_BASE_URL,
    siteUrl: SITE_URL, siteName: SITE_NAME,
  });

  const skills = await loadSkills(join(__dirname, 'skills'));
  const agentDefs = await loadAgents(join(__dirname, 'agents'));
  const pluginResources = await loadPluginResources({ workspaceRoot: process.cwd(), homeDir: process.env.HOME || process.env.USERPROFILE });
  const pluginSkills = pluginResources.skills;
  const pluginAgents = pluginResources.agents;
  const pluginTools = pluginResources.tools;
  const sreDef = agentDefs.find(a => a.name === 'sre');

  const baseTools: Tool[] = [execTool, readFileTool, writeFileTool, webFetchTool, thinkTool, waitForInputTool];
  const allTools: Tool[] = [...baseTools, ...k8sTools, ...dockerTools, ...linuxTools, ...pluginTools];

  if (MCP_COMMAND) {
    try {
      const mcpArgs = process.env.MCP_ARGS?.split(' ') || [];
      const mcp = await connectMCP(MCP_COMMAND, mcpArgs);
      allTools.push(...mcp.tools);
      mcpCleanup = mcp.close;
    } catch (e: any) {
      console.warn(`⚠️ MCP failed: ${e.message}`);
    }
  }

  allTools.push(createSpawnTool([...agentDefs, ...pluginAgents], allTools));

  agentDefsGlobal = [...agentDefs, ...pluginAgents];
  allToolsGlobal = allTools;

  // Approval handler — uses TUI confirm dialog
  approvalHandler = async (tool: string, args: any, risk: string): Promise<boolean> => {
    if (isAutoApprovable(tool, args)) return true;
    if (AUTO_APPROVE.includes(risk) || AUTO_APPROVE.includes('all')) return true;

    const question = `Approve ${tool}? risk:${risk.toUpperCase()} args:${JSON.stringify(args).slice(0, 120)}`;
    return await tui.confirm(question, risk === 'dangerous');
  };

  currentState = createAgentState({
    id: 'main', name: 'sre-agent',
    systemPrompt: sreDef?.systemPrompt || 'You are an SRE agent.',
    tools: allTools, llm, memory,
    skills: [...skills, ...pluginSkills],
    maxIterations: 50,
    onApprove: approvalHandler || undefined,
    taskRunner,
  });

  // Configure TUI
  tui.setAutocompleteCommands(COMMANDS.map(c => ({ name: c.name, description: c.desc })));

  tui.appendOutput({ type: 'system', text: `Maestro ready` });
  tui.appendOutput({ type: 'system', text: `Skills: ${skills.length + pluginSkills.length} | Agents: ${agentDefs.length + pluginAgents.length} | Tools: ${allTools.length}` });
  if (pluginResources.plugins.length) {
    tui.appendOutput({ type: 'system', text: `Plugins: ${pluginResources.plugins.map(p => p.name).join(', ')}` });
  }
  tui.appendOutput({ type: 'system', text: `Type @agent/bg <task>, /help, or just ask` });
  tui.appendOutput({ type: 'divider', text: '' });

  // Handle user submits
  tui.on('submit', (text: string) => {
    handleSubmit(text);
  });

  // Start the TUI
  tui.start();
}

// ─── Input Router ────────────────────────────────────────────────────────────

async function handleSubmit(trimmed: string) {
  if (!currentState) return;

  // ── Slash command router ──────────────────────────────────────────────────
  if (trimmed.startsWith('/')) {
    const [cmd, ...args] = trimmed.split(/\s+/);
    const subArg = args.join(' ');

    if (cmd === '/bg' || cmd === '/submit') {
      if (!subArg) { tui.appendOutput({ type: 'system', text: 'Usage: /bg <task prompt>' }); return; }
      const task = taskRunner.submitTask(currentState, subArg);
      tui.appendOutput({ type: 'system', text: `🚀 Background task submitted: [${task.id}]` });
      return;
    }

    if (cmd === '/tasks' || cmd === '/jobs') {
      const tasks = taskRunner.listTasks();
      if (tasks.length === 0) { tui.appendOutput({ type: 'system', text: '📋 No background tasks recorded.' }); return; }
      tui.appendOutput({ type: 'system', text: '📋 Background Tasks:' });
      for (const t of tasks) {
        const elapsed = t.completedAt
          ? `${((t.completedAt - t.createdAt) / 1000).toFixed(1)}s`
          : t.startedAt ? `${((Date.now() - t.startedAt) / 1000).toFixed(1)}s ▶` : 'queued';
        tui.appendOutput({ type: 'system', text: `  [${t.id}] ${t.status.toUpperCase()} @${t.agentName} | ${t.taskPrompt.slice(0, 45)} | ${elapsed}` });
      }
      return;
    }

    if (cmd === '/view') {
      if (!subArg) { tui.appendOutput({ type: 'system', text: 'Usage: /view <task-id>' }); return; }
      const task = taskRunner.getTask(subArg);
      if (!task) { tui.appendOutput({ type: 'error', text: `Task [${subArg}] not found.` }); return; }
      const dur = task.completedAt
        ? `${((task.completedAt - task.createdAt) / 1000).toFixed(1)}s`
        : task.startedAt ? `${((Date.now() - task.startedAt) / 1000).toFixed(1)}s running...` : 'queued';
      tui.appendOutput({ type: 'system', text: `📋 Task [${task.id}]  ${task.status.toUpperCase()}  (${dur})` });
      tui.appendOutput({ type: 'system', text: `   Agent: @${task.agentName} | Prompt: ${task.taskPrompt}` });
      if (task.waitingForInput && task.waitingPrompt) {
        tui.appendOutput({ type: 'system', text: `⏸️  Waiting: ${task.waitingPrompt}` });
        tui.appendOutput({ type: 'system', text: `   → /send ${task.id} y   or   /send ${task.id} n` });
      }
      if (task.messages.length > 0) {
        for (const msg of task.messages) {
          if (msg.role === 'system') continue;
          const prefix = msg.role === 'user' ? '🧑' : msg.role === 'assistant' ? '🤖' : '🔧';
          if (msg.content) tui.appendOutput({ type: 'tool', text: `${prefix} ${msg.content.slice(0, 500)}` });
        }
      }
      if (task.result && task.status === 'completed') tui.appendOutput({ type: 'result', text: task.result });
      if (task.error) tui.appendOutput({ type: 'error', text: task.error });
      return;
    }

    if (cmd === '/send') {
      const [sendTarget, ...sendParts] = args;
      if (!sendTarget || sendParts.length === 0) { tui.appendOutput({ type: 'system', text: 'Usage: /send <task-id> <input>' }); return; }
      const sendInput = sendParts.join(' ');
      const ok = taskRunner.sendInput(sendTarget, sendInput);
      tui.appendOutput({ type: 'system', text: ok ? `📤 Sent to [${sendTarget}]` : `❌ Task [${sendTarget}] not found or not waiting.` });
      return;
    }

    if (cmd === '/attach') {
      if (!subArg) { tui.appendOutput({ type: 'system', text: 'Usage: /attach <task-id>' }); return; }
      const task = taskRunner.getTask(subArg);
      if (!task) { tui.appendOutput({ type: 'error', text: `Task [${subArg}] not found.` }); return; }
      attachedTaskId = task.id;
      tui.appendOutput({ type: 'system', text: `🔗 Attached to task [${task.id}] (@${task.agentName})` });
      return;
    }

    if (cmd === '/detach') {
      if (attachedTaskId) {
        tui.appendOutput({ type: 'system', text: `🔓 Detached from task [${attachedTaskId}]` });
        attachedTaskId = null;
      } else { tui.appendOutput({ type: 'system', text: '⚠️ Not attached to any task.' }); }
      return;
    }

    if (cmd === '/cancel') {
      if (!subArg) { tui.appendOutput({ type: 'system', text: 'Usage: /cancel <task-id>' }); return; }
      const ok = taskRunner.cancelTask(subArg);
      tui.appendOutput({ type: 'system', text: ok ? `🛑 Task [${subArg}] cancelled.` : `❌ Could not cancel [${subArg}].` });
      return;
    }

    if (cmd === '/agents' || cmd === '/list-agents') {
      if (agentDefsGlobal.length === 0) { tui.appendOutput({ type: 'system', text: '👥 No agents available.' }); return; }
      tui.appendOutput({ type: 'system', text: '👥 Available Agents:' });
      for (const def of agentDefsGlobal) tui.appendOutput({ type: 'system', text: `   @${def.name} - ${def.description || '(no description)'}` });
      return;
    }

    if (cmd === '/assign' || cmd === '/assign-bg') {
      const [rawAgentName, ...taskParts] = args;
      const agentName = rawAgentName?.replace(/^@/, '');
      if (!agentName || taskParts.length === 0) { tui.appendOutput({ type: 'system', text: `Usage: /${cmd.replace(/^\//, '')} <agent-name> <task prompt>` }); return; }
      const task = taskParts.join(' ');
      const background = cmd === '/assign-bg';
      tui.appendOutput({ type: 'system', text: `👤 Running @${agentName} ${background ? '(bg)' : ''}...` });
      tui.setRunning(true);
      const result = await spawnAgent({
        agentName, task, async: background,
        agentDefs: agentDefsGlobal, allTools: allToolsGlobal,
        llm: currentState!.llm, memory: currentState!.memory,
        skills: currentState!.skills, parentId: currentState!.id,
        workingDir: currentState!.workingDir, onApprove: approvalHandler || undefined,
        taskRunner,
      });
      tui.setRunning(false);
      if (background) { tui.appendOutput({ type: 'result', text: `🚀 Assigned to @${agentName}: ${result}` }); }
      else { tui.appendOutput({ type: 'result', text: result }); }
      return;
    }

    if (cmd === '/reload') {
      try {
        const pluginResources = await loadPluginResources({ workspaceRoot: process.cwd(), homeDir: process.env.HOME || process.env.USERPROFILE });
        const freshSkills = [...(await loadSkills(join(__dirname, 'skills'))), ...pluginResources.skills];
        const freshAgentDefs = [...(await loadAgents(join(__dirname, 'agents'))), ...pluginResources.agents];
        const freshTools = [...[execTool, readFileTool, writeFileTool, webFetchTool, thinkTool, waitForInputTool], ...k8sTools, ...dockerTools, ...linuxTools, ...pluginResources.tools];
        agentDefsGlobal = freshAgentDefs;
        allToolsGlobal = freshTools;
        currentState = createAgentState({
          id: currentState?.id || 'main', name: currentState?.name || 'sre-agent',
          systemPrompt: freshAgentDefs.find(a => a.name === 'sre')?.systemPrompt || currentState?.systemPrompt || 'You are an SRE agent.',
          tools: freshTools, llm: currentState?.llm || createLLM({ apiKey: LLM_API_KEY, model: LLM_MODEL, baseURL: LLM_BASE_URL, siteUrl: SITE_URL, siteName: SITE_NAME }),
          memory: currentState?.memory || await createMemory(TURSO_URL, TURSO_TOKEN),
          skills: freshSkills, maxIterations: currentState?.maxIterations ?? 50,
          workingDir: currentState?.workingDir, parentId: currentState?.parentId,
          onApprove: approvalHandler || undefined, taskRunner,
        });
        tui.appendOutput({ type: 'system', text: `♻️  Reloaded plugins: ${pluginResources.plugins.length ? pluginResources.plugins.map(p => p.name).join(', ') : 'none'}` });
      } catch (e: any) { tui.appendOutput({ type: 'error', text: `Reload failed: ${e.message}` }); }
      return;
    }

    if (cmd === '/help') {
      tui.appendOutput({ type: 'system', text: '\x1b[1m💡 Maestro Commands\x1b[0m' });
      tui.appendOutput({ type: 'system', text: '' });
      tui.appendOutput({ type: 'system', text: '\x1b[36mMain Agent\x1b[0m   <task>  or  @<agent> <task>  or  @<agent>/bg <task>' });
      tui.appendOutput({ type: 'system', text: '\x1b[36mBackground\x1b[0m   /bg  /tasks  /view <id>  /attach <id>  /detach  /send <id>  /cancel <id>' });
      tui.appendOutput({ type: 'system', text: '\x1b[36mAgents\x1b[0m      /agents  /assign <a> <t>  /assign-bg <a> <t>' });
      tui.appendOutput({ type: 'system', text: '\x1b[36mSystem\x1b[0m      /reload  exit' });
      return;
    }

    tui.appendOutput({ type: 'error', text: `Unknown command: ${cmd}. Try /help` });
    return;
  }

  // ── @agent-name tag routing ───────────────────────────────────────────────
  const tagMatch = trimmed.match(/^@([\w.-]+)(?:\/(bg|async))?\s+(.+)$/);
  if (tagMatch) {
    const agentName = tagMatch[1]!;
    const asyncFlag = tagMatch[2];
    const task = tagMatch[3]!;
    const background = asyncFlag === 'bg' || asyncFlag === 'async';
    tui.appendOutput({ type: 'system', text: `👤 @${agentName} ${background ? '(bg)' : ''}...` });
    tui.setRunning(true);
    const result = await spawnAgent({
      agentName, task, async: background,
      agentDefs: agentDefsGlobal, allTools: allToolsGlobal,
      llm: currentState!.llm, memory: currentState!.memory,
      skills: currentState!.skills, parentId: currentState!.id,
      workingDir: currentState!.workingDir,
      onApprove: background ? createBgApprovalHandler('pending') : approvalHandler || undefined,
      taskRunner,
    });
    tui.setRunning(false);
    if (background) { tui.appendOutput({ type: 'result', text: `🚀 @${agentName} bg: ${result}` }); }
    else { tui.appendOutput({ type: 'result', text: result }); }
    return;
  }

  // ── Main agent foreground execution ───────────────────────────────────────
  tui.appendOutput({ type: 'system', text: '' });
  tui.setRunning(true);
  const startTime = Date.now();
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIdx = 0;
  let timerHandle: ReturnType<typeof setInterval> | null = null;

  // Subscribe to tool call events for live streaming
  const onLog = (data: { taskId: string; message: string }) => {
    if (data.taskId !== currentState?.id) return;
    tui.appendOutput({ type: 'tool', text: data.message });
  };
  taskRunner.on('task:log', onLog);

  try {
    const { result, state } = await runAgent(currentState, trimmed);
    currentState = state;
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    tui.appendOutput({ type: 'system', text: `✔ Done (${totalTime}s)` });
    tui.appendOutput({ type: 'result', text: result });
  } catch (e: any) {
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    tui.appendOutput({ type: 'error', text: `✖ Failed (${totalTime}s): ${e.message}` });
  } finally {
    taskRunner.off('task:log', onLog);
    tui.setRunning(false);
  }
}

// ─── Main REPL ───────────────────────────────────────────────────────────────

async function runRepl() {
  // Only used as a fallback; TUI handles input via 'submit' events
  await new Promise<void>(() => { });
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

async function shutdown() {
  if (mcpCleanup) {
    await mcpCleanup();
    mcpCleanup = null;
  }
  tui.stop();
}

main().catch(async (err) => {
  console.error(err);
  await shutdown();
  process.exit(1);
});