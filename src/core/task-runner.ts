import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { AgentState, Message } from './types';
import { runAgent } from './agent';

export type TaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface TaskRecord {
  id: string;
  agentId: string;
  agentName: string;
  taskPrompt: string;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
  logs: string[];
  /** Full conversation history — populated as the agent runs. */
  messages: Message[];
  /** Snapshot of agent state after completion (for resumption / inspection). */
  agentState?: AgentState;
  /** True when the agent is blocked on user input via wait_for_input. */
  waitingForInput?: boolean;
  /** The question the agent is asking the user. */
  waitingPrompt?: string;
  /** Internal resolver that sendInput() calls to unblock the agent. */
  waitingResolve?: (input: string) => void;
}

/**
 * Asynchronous Task Runner and Event Bus for background agent execution.
 *
 * Events emitted:
 *   - 'submitted'  (task: TaskRecord)
 *   - 'started'    (task: TaskRecord)
 *   - 'completed'  (task: TaskRecord)
 *   - 'failed'     (task: TaskRecord)
 *   - 'cancelled'  (task: TaskRecord)
 *   - 'task:log'   ({ taskId: string, message: string })
 *   - 'task:output'({ taskId: string, role: string, content: string })
 *   - 'task:status'({ taskId: string, status: TaskStatus })
 *   - 'task:waiting'({ taskId: string, prompt: string })
 */
export class TaskRunner extends EventEmitter {
  private tasks = new Map<string, TaskRecord>();
  private agentToTask = new Map<string, string>();
  /** Agent IDs that were registered via registerSyncAgent (not background tasks). */
  private syncAgents = new Set<string>();

  /**
   * Callback for prompting the user during sync agent execution.
   * Set by the main REPL's `ask` function; avoids creating duplicate readline interfaces.
   */
  promptUser: ((question: string) => Promise<string>) | null = null;

  /**
   * Submits a task to run asynchronously in the background.
   * Immediately returns the created TaskRecord.
   */
  submitTask(agentState: AgentState, prompt: string, initialMessages?: Message[]): TaskRecord {
    const id = randomUUID().slice(0, 8);
    const record: TaskRecord = {
      id,
      agentId: agentState.id,
      agentName: agentState.name,
      taskPrompt: prompt,
      status: 'queued',
      createdAt: Date.now(),
      logs: [],
      messages: initialMessages ?? [],
    };

    this.tasks.set(id, record);
    this.agentToTask.set(agentState.id, id);
    this.emit('submitted', record);

    // Dispatch background execution asynchronously
    queueMicrotask(() => this.executeTask(id, agentState, prompt));

    return record;
  }

  private async executeTask(id: string, agentState: AgentState, prompt: string) {
    const task = this.tasks.get(id);
    if (!task || task.status === 'cancelled') return;

    task.status = 'running';
    task.startedAt = Date.now();
    this.emit('started', task);
    this.emit('task:status', { taskId: id, status: 'running' });

    try {
      const { result, state } = await runAgent(agentState, prompt);

      if ((task.status as TaskStatus) === 'cancelled') return;

      task.status = 'completed';
      task.completedAt = Date.now();
      task.result = result;
      task.messages = state.messages;
      task.agentState = state;
      task.logs.push(`[COMPLETED]: ${result.slice(0, 300)}`);
      this.emit('completed', task);
      this.emit('task:status', { taskId: id, status: 'completed' });
      this.emit('task:log', { taskId: id, message: `COMPLETED in ${((task.completedAt - task.createdAt) / 1000).toFixed(1)}s` });
    } catch (err: any) {
      if ((task.status as TaskStatus) === 'cancelled') return;

      task.status = 'failed';
      task.completedAt = Date.now();
      task.error = err?.message || String(err);
      task.logs.push(`[FAILED]: ${task.error}`);
      this.emit('failed', task);
      this.emit('task:status', { taskId: id, status: 'failed' });
      this.emit('task:log', { taskId: id, message: `FAILED: ${task.error}` });
    }
  }

  /**
   * Register an agent for synchronous execution.
   * Creates a TaskRecord so that waitForInput() can find it,
   * but does NOT dispatch background execution.
   */
  registerSyncAgent(agentState: AgentState, prompt: string): TaskRecord {
    const id = randomUUID().slice(0, 8);
    const record: TaskRecord = {
      id,
      agentId: agentState.id,
      agentName: agentState.name,
      taskPrompt: prompt,
      status: 'running',
      createdAt: Date.now(),
      startedAt: Date.now(),
      logs: [],
      messages: [],
    };
    this.tasks.set(id, record);
    this.agentToTask.set(agentState.id, id);
    this.syncAgents.add(agentState.id);
    return record;
  }

  isSyncAgent(agentId: string): boolean {
    return this.syncAgents.has(agentId);
  }

  /**
   * Called by the `wait_for_input` tool handler.
   * Accepts either a task record ID or an agent ID.
   * Creates a promise that blocks the agent until the user sends input via sendInput().
   */
  waitForInput(taskIdOrAgentId: string, question: string): Promise<string> {
    const taskId = this.agentToTask.get(taskIdOrAgentId) ?? taskIdOrAgentId;
    const task = this.tasks.get(taskId);
    if (!task) {
      return Promise.resolve('[Error: task not found]');
    }

    task.waitingForInput = true;
    task.waitingPrompt = question;
    task.status = 'waiting';
    this.emit('task:waiting', { taskId, prompt: question });
    this.emit('task:status', { taskId, status: 'waiting' });

    return new Promise<string>((resolve) => {
      task.waitingResolve = resolve;
    });
  }

  /**
   * Sends user input to a waiting task, resuming its execution.
   * Called by the `/send` REPL command.
   * Accepts either a task record ID or an agent ID.
   */
  sendInput(taskIdOrAgentId: string, input: string): boolean {
    const taskId = this.agentToTask.get(taskIdOrAgentId) ?? taskIdOrAgentId;
    const task = this.tasks.get(taskId);
    if (!task || !task.waitingForInput || !task.waitingResolve) {
      return false;
    }

    task.waitingForInput = false;
    task.waitingResolve(input);
    task.waitingResolve = undefined;
    task.waitingPrompt = undefined;
    task.status = 'running';
    this.emit('task:log', { taskId, message: `User input: ${input.slice(0, 200)}` });
    this.emit('task:status', { taskId, status: 'running' });
    return true;
  }

  /**
   * Append a live message to the task's conversation history.
   * Called by the agent loop to stream output in real-time.
   */
  appendMessage(taskId: string, msg: Message): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.messages = [...task.messages, msg];
  }

  getTask(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  listTasks(): TaskRecord[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  cancelTask(idOrAgentId: string): boolean {
    const taskId = this.agentToTask.get(idOrAgentId) ?? idOrAgentId;
    const task = this.tasks.get(taskId);
    if (!task || task.status === 'completed' || task.status === 'failed') return false;

    // If the task is waiting for input, resolve with a cancellation message
    if (task.waitingForInput && task.waitingResolve) {
      task.waitingResolve('[Task cancelled by user]');
      task.waitingResolve = undefined;
      task.waitingForInput = false;
      task.waitingPrompt = undefined;
    }

    task.status = 'cancelled';
    task.completedAt = Date.now();
    task.logs.push('[CANCELLED]: Task cancelled by user');
    this.emit('cancelled', task);
    this.emit('task:status', { taskId, status: 'cancelled' });
    return true;
  }
}