import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { AgentState } from './types';
import { runAgent } from './agent';

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

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
}

/**
 * Asynchronous Task Runner and Event Bus for background agent execution.
 */
export class TaskRunner extends EventEmitter {
  private tasks = new Map<string, TaskRecord>();

  /**
   * Submits a task to run asynchronously in the background.
   * Immediately returns the created TaskRecord.
   */
  submitTask(agentState: AgentState, prompt: string): TaskRecord {
    const id = randomUUID().slice(0, 8);
    const record: TaskRecord = {
      id,
      agentId: agentState.id,
      agentName: agentState.name,
      taskPrompt: prompt,
      status: 'queued',
      createdAt: Date.now(),
      logs: [],
    };

    this.tasks.set(id, record);
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

    try {
      const { result } = await runAgent(agentState, prompt);

      if ((task.status as TaskStatus) === 'cancelled') return;

      task.status = 'completed';
      task.completedAt = Date.now();
      task.result = result;
      task.logs.push(`[COMPLETED]: ${result.slice(0, 300)}`);
      this.emit('completed', task);
    } catch (err: any) {
      if ((task.status as TaskStatus) === 'cancelled') return;

      task.status = 'failed';
      task.completedAt = Date.now();
      task.error = err?.message || String(err);
      task.logs.push(`[FAILED]: ${task.error}`);
      this.emit('failed', task);
    }
  }

  getTask(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  listTasks(): TaskRecord[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  cancelTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status === 'completed' || task.status === 'failed') return false;

    task.status = 'cancelled';
    task.completedAt = Date.now();
    task.logs.push('[CANCELLED]: Task cancelled by user');
    this.emit('cancelled', task);
    return true;
  }
}
