/**
 * Status bar — pinned bottom line showing system state.
 *
 * Layout (single line):
 *   [Model] [Git Branch] [Tokens] [Agent State]
 *
 * Updates in-place via the screen's dirty-tracking.
 */

import { Screen, style, cursorTo, clearLine } from './screen';

export interface StatusBarState {
  model: string;
  gitBranch: string;
  tokensUsed: number;
  promptTokens: number;
  completionTokens: number;
  state: 'idle' | 'thinking' | 'running' | 'waiting' | 'error';
}

const defaultState: StatusBarState = {
  model: '',
  gitBranch: '',
  tokensUsed: 0,
  promptTokens: 0,
  completionTokens: 0,
  state: 'idle',
};

const STATE_LABELS: Record<StatusBarState['state'], string> = {
  idle: '⚪ Idle',
  thinking: '🤔 Thinking',
  running: '▶ Running',
  waiting: '⏸ Waiting',
  error: '✖ Error',
};

const STATE_COLORS: Record<StatusBarState['state'], string> = {
  idle: style.gray,
  thinking: style.cyan,
  running: style.green,
  waiting: style.yellow,
  error: style.red,
};

export class StatusBar {
  private state: StatusBarState = { ...defaultState };
  private screen: Screen;

  constructor(screen: Screen) {
    this.screen = screen;
  }

  update(partial: Partial<StatusBarState>): void {
    Object.assign(this.state, partial);
    this.render();
  }

  addTokens(prompt: number, completion: number): void {
    this.state.promptTokens += prompt;
    this.state.completionTokens += completion;
    this.state.tokensUsed += prompt + completion;
    this.render();
  }

  resetTokens(): void {
    this.state.tokensUsed = 0;
    this.state.promptTokens = 0;
    this.state.completionTokens = 0;
    this.render();
  }

  private render(): void {
    const cols = this.screen.cols;
    const row = this.screen.rows - 1; // last line

    // Build segments
    const segments: string[] = [];

    // Model name
    if (this.state.model) {
      segments.push(`${style.dim}${this.state.model}${style.reset}`);
    }

    // Git branch
    if (this.state.gitBranch) {
      segments.push(`${style.gray}⎇ ${this.state.gitBranch}${style.reset}`);
    }

    // Tokens
    if (this.state.tokensUsed > 0) {
      const tokenStr = this.formatTokens(this.state.tokensUsed);
      segments.push(`${style.gray}${tokenStr}t${style.reset}`);
    }

    // State
    const stateColor = STATE_COLORS[this.state.state] || style.gray;
    const stateLabel = STATE_LABELS[this.state.state] || '⚪';
    segments.push(`${stateColor}${stateLabel}${style.reset}`);

    // Combine with separator
    const fullText = segments.join(` ${style.dim}·${style.reset} `);

    // Truncate or pad to fit
    const cleanText = stripAnsi(fullText);
    const display = cleanText.length > cols
      ? fullText.slice(0, cols)
      : fullText + ' '.repeat(Math.max(0, cols - cleanText.length));

    this.screen.writeLine(row, display);
    this.screen.requestFrame();
  }

  private formatTokens(n: number): string {
    if (n < 1_000) return String(n);
    if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(1)}m`;
  }
}

/** Strip ANSI escape codes from a string for length measurement. */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][0-9;]*\x07/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '');
}