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

// ─── Terminal / Readline Setup ──────────────────────────────────────────────
// Raw mode + keypress events enable inline editing (arrow, home/end, backspace),
// Tab completion, and a responsive event-driven REPL.

const COMMANDS = [
  { name: '/bg',        desc: '/bg <prompt>              Run task in background' },
  { name: '/tasks',     desc: '/tasks                    List all background tasks' },
  { name: '/view',      desc: '/view <id>                Show task conversation & result' },
  { name: '/attach',    desc: '/attach <id>              Focus terminal on a bg task' },
  { name: '/detach',    desc: '/detach                   Return to main agent' },
  { name: '/send',      desc: '/send <id> <input>        Send input/approval to waiting task' },
  { name: '/cancel',    desc: '/cancel <id>              Cancel a background task' },
  { name: '/agents',    desc: '/agents                   List available agent presets' },
  { name: '/assign',    desc: '/assign <agent> <task>    Run agent task in foreground' },
  { name: '/assign-bg', desc: '/assign-bg <agent> <task> Run agent task in background' },
  { name: '/reload',    desc: '/reload                   Reload plugins without restart' },
  { name: '/help',      desc: '/help                     Show all commands' },
];

/**
 * Readline tab completer — works on systems where readline properly intercepts Tab.
 */
function completer(line: string): [string[], string] {
  const cmdNames = COMMANDS.map(c => c.name);

  if (line.startsWith('/')) {
    const hits = cmdNames.filter(c => c.startsWith(line));
    if (hits.length > 0) return [hits, line];
    return [cmdNames, '/'];
  }

  if (line.startsWith('@')) {
    const agentTags = agentDefsGlobal.flatMap(a => [`@${a.name}`, `@${a.name}/bg`, `@${a.name}/async`]);
    const hits = agentTags.filter(n => n.startsWith(line));
    return [hits.length ? hits : agentTags, line];
  }

  if (!line.trim()) return [cmdNames, ''];
  return [[], line];
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> ',
  terminal: true,
  crlfDelay: Infinity,
  completer,
});

// Enable keypress events for Tab handling fallback (Windows compatibility)
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  try { process.stdin.setRawMode(true); } catch {}
}

/** Prints a line above the active prompt without destroying the user's input. */
function printAbove(message: string): void {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(message + '\n');
  (rl as any)._refreshLine?.();
}

/**
 * Tab completion handler — invoked directly from keypress events.
 * More reliable than readline's built-in completer on Windows terminals.
 */
function handleTab() {
  const line = rl.line;
  let completions: string[] = [];

  if (line.startsWith('/')) {
    completions = COMMANDS.map(c => c.name).filter(c => c.startsWith(line));
  } else if (line.startsWith('@')) {
    const agentTags = agentDefsGlobal.flatMap(a => [`@${a.name}`, `@${a.name}/bg`, `@${a.name}/async`]);
    completions = agentTags.filter(n => n.startsWith(line));
  } else {
    completions = COMMANDS.map(c => c.name);
  }

  if (completions.length === 1 && completions[0] !== line) {
    // Unique match — replace the line
    rl.write(null, { ctrl: true, name: 'u' }); // clear
    rl.write(completions[0] + ' ');
  } else if (completions.length > 1) {
    // Show options above the prompt
    printAbove('\x1b[90m' + completions.join('  ') + '\x1b[0m');
  } else if (completions.length === 0 && line) {
    printAbove('\x1b[90m(no completions)\x1b[0m');
  }
}

// Listen for Tab keypress (fallback for terminals where readline completer doesn't fire)
process.stdin.on('keypress', (str: string, key: any) => {
  // Only handle actual Tab key — str is '\t' or key.name is 'tab'
  // Skip for all other keys (arrows, backspace, regular chars, etc.)
  if (str === '\t' || (key && key.name === 'tab')) {
    handleTab();
  }
});

// ─── Event-driven REPL with Input Queuing ──────────────────────────────────
// Uses rl.on('line') instead of blocking await rl.question().
// When the main agent is busy (running an LLM call), new input is queued
// with a visual indicator. Queued input auto-processes when the agent finishes.

let replBusy = false;
let inputQueue: string[] = [];

// Flag to distinguish rl.question() line events from normal REPL input.
// When set, the on('line') handler skips the line (question() handles it).
let inApprovalPrompt = false;

/**
 * Prompts the user for approval or short input during an agent session.
 * Uses rl.question() under the hood; the inApprovalPrompt flag prevents
 * the event-driven handler from double-processing the response.
 */
function ask(q: string): Promise<string> {
  return new Promise(resolve => {
    inApprovalPrompt = true;
    rl.question(q, (answer: string) => {
      // Resolve first — our on('line') handler will consume the flag
      resolve(answer);
    });
  });
}

/**
 * Main input handler — parses and executes the user's line.
 * This is async so queued input can await its completion.
 */
async function processLine(line: string): Promise<void> {
  const trimmed = line.trim();

  if (trimmed === 'exit' || trimmed === 'quit') {
    await shutdown();
    process.exit(0);
    return;
  }

  if (!trimmed || !currentState) return;

  // ── Slash command router ──────────────────────────────────────────────────
  if (trimmed.startsWith('/')) {
    const [cmd, ...args] = trimmed.split(/\s+/);
    const subArg = args.join(' ');

    if (cmd === '/bg' || cmd === '/submit') {
      if (!subArg) {
        console.log(' Usage: /bg <task prompt>\n');
        return;
      }
      const task = taskRunner.submitTask(currentState, subArg);
      console.log(`\n🚀 Background task submitted: [${task.id}]\n`);
      return;
    }

    if (cmd === '/tasks' || cmd === '/jobs') {
      const tasks = taskRunner.listTasks();
      if (tasks.length === 0) {
        console.log('\n📋 No background tasks recorded.\n');
        return;
      }
      console.log('\n📋 Background Tasks:');
      for (const t of tasks) {
        const elapsed = t.completedAt
          ? `${((t.completedAt - t.createdAt) / 1000).toFixed(1)}s`
          : t.startedAt
            ? `${((Date.now() - t.startedAt) / 1000).toFixed(1)}s ▶`
            : 'queued';
        const statusColor = t.status === 'completed'
          ? '\x1b[32m' : t.status === 'failed'
            ? '\x1b[31m' : t.status === 'waiting'
              ? '\x1b[33m' : t.status === 'running'
                ? '\x1b[36m' : '\x1b[90m';
        console.log(`  [${t.id}] ${statusColor}${t.status.toUpperCase()}\x1b[0m @${t.agentName} | ${t.taskPrompt.slice(0, 45)} | ${elapsed}`);
      }
      console.log('');
      return;
    }

    if (cmd === '/view') {
      if (!subArg) { console.log(' Usage: /view <task-id>\n'); return; }
      const task = taskRunner.getTask(subArg);
      if (!task) { console.log(`❌ Task [${subArg}] not found.\n`); return; }
      const dur = task.completedAt
        ? `${((task.completedAt - task.createdAt) / 1000).toFixed(1)}s`
        : task.startedAt ? `${((Date.now() - task.startedAt) / 1000).toFixed(1)}s running...` : 'queued';
      console.log(`\n📋 Task [${task.id}]  ${task.status.toUpperCase()}  (${dur})`);
      console.log(`   Agent: @${task.agentName}`);
      console.log(`   Prompt: ${task.taskPrompt}`);
      if (task.waitingForInput && task.waitingPrompt) {
        console.log(`\n⏸️  Waiting for input:`);
        console.log(`   ${task.waitingPrompt}`);
        console.log(`\x1b[90m   → /send ${task.id} y   or   /send ${task.id} n\x1b[0m`);
      }
      if (task.messages.length > 0) {
        console.log(`\n── Conversation ──`);
        for (const msg of task.messages) {
          if (msg.role === 'system') continue;
          const prefix = msg.role === 'user' ? '🧑' : msg.role === 'assistant' ? '🤖' : msg.role === 'tool' ? '🔧' : '❓';
          if (msg.content) console.log(`   ${prefix} ${msg.content.slice(0, 500)}`);
          if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              console.log(`     ⚡ ${tc.function.name}(${tc.function.arguments.slice(0, 200)})`);
            }
          }
        }
      }
      if (task.result && task.status === 'completed') console.log(`\n✓ Final result:\n${task.result}\n`);
      if (task.error) console.log(`\n✗ Error:\n${task.error}\n`);
      console.log('');
      return;
    }

    if (cmd === '/send') {
      const [sendTarget, ...sendParts] = args;
      if (!sendTarget || sendParts.length === 0) { console.log(' Usage: /send <task-id> <input>\n'); return; }
      const sendInputText = sendParts.join(' ');
      const ok = taskRunner.sendInput(sendTarget, sendInputText);
      if (ok) { console.log(`\n📤 Sent input to task [${sendTarget}].\n`); }
      else { console.log(`\n❌ Task [${sendTarget}] not found or not waiting for input.\n`); }
      return;
    }

    if (cmd === '/attach') {
      if (!subArg) { console.log(' Usage: /attach <task-id>\n'); return; }
      const task = taskRunner.getTask(subArg);
      if (!task) { console.log(`❌ Task [${subArg}] not found.\n`); return; }
      await attachToTask(task.id);
      return;
    }

    if (cmd === '/detach') {
      if (attachedTaskId) {
        console.log(`\n🔓 Detached from task [${attachedTaskId}]. Task continues in background.\n`);
        attachedTaskId = null;
      } else { console.log('\n⚠️  Not attached to any task.\n'); }
      return;
    }

    if (cmd === '/cancel') {
      if (!subArg) { console.log(' Usage: /cancel <task-id>\n'); return; }
      const ok = taskRunner.cancelTask(subArg);
      if (ok) { console.log(`\n🛑 Task [${subArg}] cancelled.\n`); }
      else { console.log(`❌ Could not cancel task [${subArg}].\n`); }
      return;
    }

    if (cmd === '/agents' || cmd === '/list-agents') {
      if (agentDefsGlobal.length === 0) { console.log('\n👥 No agents available.\n'); return; }
      console.log('\n👥 Available Agents:');
      for (const def of agentDefsGlobal) console.log(`   @${def.name} - ${def.description || '(no description)'}`);
      console.log('');
      return;
    }

    if (cmd === '/assign' || cmd === '/assign-bg') {
      const [agentName, ...taskParts] = args;
      if (!agentName || taskParts.length === 0) { console.log(` Usage: /${cmd} <agent-name> <task prompt>\n`); return; }
      const taskText = taskParts.join(' ');
      const background = cmd === '/assign-bg';
      const result = await spawnAgent({
        agentName, task: taskText, async: background,
        agentDefs: agentDefsGlobal, allTools: allToolsGlobal,
        llm: currentState!.llm, memory: currentState!.memory,
        skills: currentState!.skills, parentId: currentState!.id,
        workingDir: currentState!.workingDir, onApprove: approvalHandler || undefined,
        taskRunner,
      });
      if (background) { console.log(`\n🚀 Assigned task to @${agentName} in background: ${result}\n`); }
      else { console.log(`\n📋 @${agentName} Result:\n${result}\n`); }
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
        console.log(`\n♻️  Reloaded plugins: ${pluginResources.plugins.length ? pluginResources.plugins.map(p => p.name).join(', ') : 'none'}\n`);
      } catch (e: any) { console.log(`\n❌ Reload failed: ${e.message}\n`); }
      return;
    }

    if (cmd === '/help') {
      console.log('\n\x1b[1m💡 Maestro Commands\x1b[0m');
      console.log(''); console.log('\x1b[36mMain Agent\x1b[0m');
      console.log('   <task>               Run task in main chat (foreground)');
      console.log('   @<agent> <task>      Tag agent, run in foreground');
      console.log('   @<agent>/bg <task>   Tag agent, run in background');
      console.log(''); console.log('\x1b[36mBackground Tasks\x1b[0m');
      console.log('   /bg <prompt>         Submit task to background queue');
      console.log('   /tasks               List all background tasks (status, timing)');
      console.log('   /view <id>           Show conversation, result, or pending approvals');
      console.log('   /attach <id>         Switch focus to a running background task');
      console.log('   /detach              Return to main agent from attached task');
      console.log('   /send <id> <input>   Send input / approve (y/n) to waiting task');
      console.log('   /cancel <id>         Cancel a running background task');
      console.log(''); console.log('\x1b[36mAgents\x1b[0m');
      console.log('   /agents              List available agent presets');
      console.log('   /assign <a> <task>   Assign task to agent (foreground)');
      console.log('   /assign-bg <a> <t>   Assign task to agent in background');
      console.log(''); console.log('\x1b[36mSystem\x1b[0m');
      console.log('   /reload              Reload plugins and skills without restart');
      console.log('   exit                 Exit Maestro (or press Ctrl+C twice)\n');
      return;
    }

    // Unknown slash command
    console.log(`\x1b[33m⚠️  Unknown command: ${cmd}. Try /help\x1b[0m\n`);
    return;
  }

  // ── @agent-name tag routing ───────────────────────────────────────────────
  const tagMatch = trimmed.match(/^@([\w.-]+)(?:\/(bg|async))?\s+(.+)$/);
  if (tagMatch) {
    const agentName = tagMatch[1]!;
    const asyncFlag = tagMatch[2];
    const task = tagMatch[3]!;
    const background = asyncFlag === 'bg' || asyncFlag === 'async';
    const result = await spawnAgent({
      agentName, task, async: background,
      agentDefs: agentDefsGlobal, allTools: allToolsGlobal,
      llm: currentState!.llm, memory: currentState!.memory,
      skills: currentState!.skills, parentId: currentState!.id,
      workingDir: currentState!.workingDir,
      onApprove: background ? createBgApprovalHandler('pending') : approvalHandler || undefined,
      taskRunner,
    });
    if (background) { console.log(`\n🚀 Assigned task to @${agentName} in background: ${result}\n`); }
    else { console.log(`\n📋 @${agentName} Result:\n${result}\n`); }
    return;
  }

  // ── Main agent foreground execution ───────────────────────────────────────
  const mainId = currentState!.id;
  let timerHandle: ReturnType<typeof setInterval> | null = null;
  let lastAction = '';
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIdx = 0;
  let startTime = Date.now();

  const renderStatus = () => {
    const frame = spinnerFrames[frameIdx % spinnerFrames.length];
    frameIdx++;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const action = lastAction ? ` \x1b[90m⚡${lastAction.slice(0, 60)}\x1b[0m` : '';
    process.stdout.write(`\r\x1b[K\x1b[36m${frame}\x1b[0m \x1b[90m${elapsed}s${action}\x1b[0m`);
  };

  /** Log a line ABOVE the status line during execution. */
  const logDuringExec = (msg: string) => {
    process.stdout.write(`\r\x1b[K${msg}\n`);
    renderStatus();
  };

  const onOutput = (data: { taskId: string; role: string; content: string }) => {
    if (data.taskId !== mainId) return;
    if (data.role === 'tool') {
      lastAction = data.content.slice(0, 60);
      logDuringExec(`  \x1b[90m⚡ ${lastAction}\x1b[0m`);
    }
  };

  const onLog = (data: { taskId: string; message: string }) => {
    if (data.taskId !== mainId) return;
    logDuringExec(`  \x1b[90m${data.message}\x1b[0m`);
  };

  timerHandle = setInterval(renderStatus, 100);
  renderStatus();
  taskRunner.on('task:output', onOutput);
  taskRunner.on('task:log', onLog);

  try {
    const { result, state } = await runAgent(currentState, trimmed);
    currentState = state;
    if (timerHandle) clearInterval(timerHandle);
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    // Replace status line with Done indicator
    process.stdout.write(`\r\x1b[K\x1b[32m✔ Done\x1b[0m \x1b[90m(${totalTime}s)\x1b[0m\n`);
    console.log(`\n📋 Result:\n${result}\n`);
  } catch (e: any) {
    if (timerHandle) clearInterval(timerHandle);
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(`\r\x1b[K\x1b[31m✖ Failed\x1b[0m \x1b[90m(${totalTime}s)\x1b[0m\n`);
    console.error(`\n❌ Error: ${e.message}\n`);
  } finally {
    taskRunner.off('task:output', onOutput);
    taskRunner.off('task:log', onLog);
  }
}

// ── Queued input processing ─────────────────────────────────────────────────
// After processLine completes, check if there's queued input and process it.
async function processLineWithQueue(line: string): Promise<void> {
  replBusy = true;
  try {
    await processLine(line);
  } finally {
    replBusy = false;

    // Process next queued item (if any)
    if (inputQueue.length > 0) {
      const next = inputQueue.shift()!;
      printAbove(`\x1b[90m▶ Processing queued input (${inputQueue.length} remaining)\x1b[0m`);
      // Recursively process queued items
      setImmediate(() => processLineWithQueue(next));
    } else {
      rl.prompt();
    }
  }
}

// ── Event-driven REPL ──────────────────────────────────────────────────────
// Every line from the user goes through this handler.
// If the agent is busy, input is queued and shown with a 📥 indicator.
rl.on('line', (line: string) => {
  // If rl.question() is active, skip — it handles the line itself
  if (inApprovalPrompt) {
    inApprovalPrompt = false;
    return;
  }

  const trimmed = line.trimEnd();
  if (!trimmed) { rl.prompt(); return; }

  if (replBusy) {
    inputQueue.push(trimmed);
    printAbove(`\x1b[90m📥 Queued (${inputQueue.length})\x1b[0m`);
    rl.prompt();
    return;
  }

  processLineWithQueue(trimmed);
});

// ─── Ctrl+C: double-press to exit ────────────────────────────────────────────
// Fix: On Windows, readline in TTY mode intercepts Ctrl+C and emits
// rl.on('SIGINT') INSTEAD of process.on('SIGINT'). Must listen on BOTH.
// A 100ms debounce ensures both paths never double-count the same keypress.

let sigintCount = 0;
let sigintTimer: ReturnType<typeof setTimeout> | null = null;
let lastSigintMs = 0;

function handleSigint() {
  const now = Date.now();
  if (now - lastSigintMs < 150) return; // debounce: one signal per 150ms
  lastSigintMs = now;

  sigintCount++;
  if (sigintCount === 1) {
    printAbove('\n\x1b[33m⚠️  Press Ctrl+C again within 2s to exit. Press Enter to keep going.\x1b[0m\n');
    if (sigintTimer) clearTimeout(sigintTimer);
    sigintTimer = setTimeout(() => { sigintCount = 0; sigintTimer = null; }, 2000);
  } else {
    if (sigintTimer) clearTimeout(sigintTimer);
    shutdown().finally(() => process.exit(0));
  }
}

// rl.on('SIGINT') fires on Windows when readline handles Ctrl+C in raw mode
rl.on('SIGINT', handleSigint);
// process.on('SIGINT') fires on Linux/macOS and some Windows configs
process.on('SIGINT', handleSigint);
process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)));

// ─── Background Task Notification Bus ────────────────────────────────────────
// Fix #2 & #3: Route ALL background task events through printAbove() so they
// appear above the prompt as status banners, not interleaved with main output.

function bgTag(taskId: string, agentName: string): string {
  return `\x1b[90m[bg:${taskId.slice(0, 6)} @${agentName}]\x1b[0m`;
}

taskRunner.on('started', (task: TaskRecord) => {
  printAbove(`${bgTag(task.id, task.agentName)} \x1b[36m▶ Started\x1b[0m`);
});

taskRunner.on('completed', (task: TaskRecord) => {
  const dur = task.completedAt && task.startedAt
    ? ` (${((task.completedAt - task.startedAt) / 1000).toFixed(1)}s)`
    : '';
  printAbove(`${bgTag(task.id, task.agentName)} \x1b[32m✓ Completed${dur} — /view ${task.id}\x1b[0m`);
});

taskRunner.on('failed', (task: TaskRecord) => {
  const short = task.error?.slice(0, 80) ?? 'unknown error';
  printAbove(`${bgTag(task.id, task.agentName)} \x1b[31m✗ Failed: ${short}\x1b[0m`);
});

taskRunner.on('cancelled', (task: TaskRecord) => {
  printAbove(`${bgTag(task.id, task.agentName)} \x1b[33m⊘ Cancelled\x1b[0m`);
});

// Approval gate banners (fix #5)
taskRunner.on('task:waiting', (data: { taskId: string; prompt: string }) => {
  const task = taskRunner.getTask(data.taskId);
  const name = task?.agentName ?? 'agent';
  printAbove(`\n\x1b[43m\x1b[30m 🔒 ACTION REQUIRED \x1b[0m ${bgTag(data.taskId, name)}`);
  printAbove(`\x1b[33m   ${data.prompt}\x1b[0m`);
  printAbove(`\x1b[90m   Approve: /send ${data.taskId} y    Deny: /send ${data.taskId} n\x1b[0m\n`);
});

// Suppress noisy mid-run output by default; use /attach or /view for details.
// Only show the final result when completed.
taskRunner.on('task:output', (data: { taskId: string; role: string; content: string }) => {
  if (attachedTaskId === data.taskId) {
    // If the user is attached to this task, show output directly
    const prefix = data.role === 'assistant' ? '🤖' : data.role === 'tool' ? '🔧' : '📋';
    printAbove(`   ${prefix} ${data.content.slice(0, 300)}`);
  }
});

// ─── Per-task Approval Handler (for background agents) ───────────────────────
// Fix #5: Background agents use waitForInput instead of blocking main readline.
// Approval request shows as a banner; user resolves via /send <id> y/n.

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

  const baseTools: Tool[] = [execTool, readFileTool, writeFileTool, webFetchTool, thinkTool, waitForInputTool];
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

  agentDefsGlobal = [...agentDefs, ...pluginAgents];
  allToolsGlobal = allTools;

  // Main agent's approval handler — uses the main readline synchronously
  approvalHandler = async (tool: string, args: any, risk: string): Promise<boolean> => {
    if (isAutoApprovable(tool, args)) return true;
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
    taskRunner,
  });

  console.log('🚀 SRE Agent ready.');
  console.log(`   Skills: ${skills.length + pluginSkills.length} | Agents: ${agentDefs.length + pluginAgents.length} | Tools: ${allTools.length}`);
  if (pluginResources.plugins.length) {
    console.log(`   Plugins: ${pluginResources.plugins.map(p => p.name).join(', ')}`);
  }
  console.log(`   LLM: ${LLM_MODEL} via OpenRouter`);
  console.log('   Type a task, @agent/bg <task>, /help, or "exit"\n');

  await runRepl();
  await shutdown();
}

// ─── Attach to a Background Task ──────────────────────────────────────────────

async function attachToTask(taskId: string) {
  const task = taskRunner.getTask(taskId);
  if (!task) {
    console.log(`❌ Task [${taskId}] not found.\n`);
    return;
  }

  attachedTaskId = taskId;

  console.log(`\n🔗 Attached to task [${taskId}] (@${task.agentName}).`);
  console.log(`   Status: ${task.status.toUpperCase()}`);
  console.log(`   Prompt: ${task.taskPrompt}`);
  console.log(`   Type 'detach' to leave, or send input to a waiting task.\n`);

  if (task.messages.length > 0) {
    console.log('── Conversation ──');
    for (const msg of task.messages) {
      if (msg.role === 'system') continue;
      const prefix = msg.role === 'user' ? '🧑' : msg.role === 'assistant' ? '🤖' : msg.role === 'tool' ? '🔧' : '❓';
      const content = msg.content?.slice(0, 300) ?? '';
      if (content) console.log(`   ${prefix} ${content}`);
    }
    console.log('');
  }

  if (task.waitingForInput && task.waitingPrompt) {
    console.log(`⏸️  Task is waiting for input:`);
    console.log(`   ${task.waitingPrompt}\n`);
  }

  // While attached: stream all output to the terminal via printAbove
  const onOutput = (data: { taskId: string; role: string; content: string }) => {
    if (data.taskId !== taskId) return;
    const prefix = data.role === 'assistant' ? '🤖' : data.role === 'tool' ? '🔧' : data.role === 'result' ? '📋' : '❓';
    printAbove(`   ${prefix} ${data.content.slice(0, 300)}`);
  };
  const onLog = (data: { taskId: string; message: string }) => {
    if (data.taskId !== taskId) return;
    printAbove(`   📝 ${data.message}`);
  };

  taskRunner.on('task:output', onOutput);
  taskRunner.on('task:log', onLog);

  try {
    while (attachedTaskId === taskId) {
      const currentPrompt = `task-${taskId.slice(0, 6)}> `;
      const input = await ask(currentPrompt);
      const trimmed = input.trim();

      if (trimmed === 'detach' || trimmed === 'exit' || trimmed === 'quit') {
        console.log(`\n🔓 Detached from task [${taskId}]. Task continues in background.\n`);
        attachedTaskId = null;
        break;
      }

      if (!trimmed) continue;

      const currentTask = taskRunner.getTask(taskId);
      if (!currentTask) {
        console.log('❌ Task no longer exists.\n');
        break;
      }

      if (currentTask.waitingForInput) {
        const ok = taskRunner.sendInput(taskId, trimmed);
        if (ok) {
          console.log(`   📤 Sent: ${trimmed}\n`);
        } else {
          console.log('❌ Could not send input.\n');
        }
      } else if (currentTask.status === 'completed' || currentTask.status === 'failed') {
        console.log('⚠️  Task is already finished. Type "detach" and use /view to see results.\n');
      } else {
        console.log('   (Task is running — it will accept input when it pauses)\n');
      }
    }
  } finally {
    taskRunner.off('task:output', onOutput);
    taskRunner.off('task:log', onLog);
    // Restore main prompt
    rl.setPrompt('> ');
  }
}

// ─── Main REPL (event-driven) ───────────────────────────────────────────────
// Called once from main(). Shows the initial prompt; all further input is
// handled by rl.on('line') above.

async function runRepl() {
  rl.prompt();
  // Wait indefinitely (Ctrl+C or exit/quit shuts down)
  await new Promise<void>(() => {});
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

async function shutdown() {
  if (mcpCleanup) {
    await mcpCleanup();
    mcpCleanup = null;
  }
  rl.close();
}

main().catch(async (err) => {
  console.error(err);
  await shutdown();
  process.exit(1);
});