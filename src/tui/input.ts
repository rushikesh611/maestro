/**
 * Raw input processor — key bindings, mouse events, multi-line editor.
 *
 * Parses raw stdin bytes into semantic actions:
 *   - Arrow keys, Home, End, PageUp, PageDown
 *   - Ctrl+letter combinations
 *   - Alt+key combinations (word jumps)
 *   - Mouse wheel, click, drag (SGR encoding)
 *   - Regular character input
 */

import { EventEmitter } from 'events';

// ─── Key Event Types ────────────────────────────────────────────────────

export type KeyModifier = 'none' | 'shift' | 'alt' | 'ctrl';

export interface KeyEvent {
  type: 'key';
  name: string;
  modifier: KeyModifier;
  /** The printable character (if any). */
  char?: string;
  /** Raw ANSI sequence. */
  sequence: string;
}

export interface MouseEvent {
  type: 'mouse';
  event: 'up' | 'down' | 'drag' | 'scroll_up' | 'scroll_down';
  row: number;
  col: number;
  button: 'left' | 'middle' | 'right' | 'none';
}

export type InputEvent = KeyEvent | MouseEvent;

// ─── Input Handler ──────────────────────────────────────────────────────

export class InputHandler extends EventEmitter {
  private buffer = '';
  private rawMode = false;
  private mouseEnabled = false;
  private keyRepeatTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Start listening on stdin. */
  start(): void {
    if (this.rawMode) return;
    this.rawMode = true;

    // Set stdin to raw mode for per-keypress processing
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', this.onData);
  }

  /** Stop listening and restore stdin. */
  stop(): void {
    if (!this.rawMode) return;
    this.rawMode = false;
    process.stdin.removeListener('data', this.onData);
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
    this.clearKeyRepeatTimers();
  }

  private onData = (data: string): void => {
    this.buffer += data;
    this.processBuffer();
  };

  /** Try to parse one or more complete ANSI sequences from the buffer. */
  private processBuffer(): void {
    while (this.buffer.length > 0) {
      const event = this.tryParse(this.buffer);

      if (!event) {
        // Incomplete sequence — wait for more data
        break;
      }

      // Remove the consumed bytes from the buffer
      const consumed = event.type === 'mouse' ? 6 : event.sequence.length;
      this.buffer = this.buffer.slice(consumed);

      this.emit('input', event);
    }
  }

  /**
   * Try to parse an event from the start of the buffer.
   * Returns null if we need more bytes.
   */
  private tryParse(buffer: string): InputEvent | null {
    // CSI sequences start with ESC [
    if (buffer.startsWith('\x1b[')) {
      return this.parseCSI(buffer);
    }

    // ESC sequences (Alt+key or standalone ESC)
    if (buffer.startsWith('\x1b') && buffer.length >= 2) {
      return this.parseEsc(buffer);
    }

    // Regular characters and control characters
    const char = buffer[0]!;
    const code = char.charCodeAt(0);

    // Tab
    if (code === 9) {
      return { type: 'key', name: 'tab', modifier: 'none', char: '\t', sequence: char };
    }

    // Enter
    if (code === 13 || code === 10) {
      return { type: 'key', name: 'return', modifier: 'none', char: '\n', sequence: char };
    }

    // Backspace
    if (code === 127 || code === 8) {
      return { type: 'key', name: 'backspace', modifier: 'none', sequence: char };
    }

    // Escape
    if (code === 27) {
      return { type: 'key', name: 'escape', modifier: 'none', sequence: char };
    }

    // Ctrl+letter (codes 1-26)
    if (code >= 1 && code <= 26) {
      const ctrlLetter = String.fromCharCode(96 + code); // 1=A, 2=B, ..., 26=Z
      return { type: 'key', name: ctrlLetter, modifier: 'ctrl', char: ctrlLetter, sequence: char };
    }

    // Regular printable character
    if (code >= 32) {
      return { type: 'key', name: char, modifier: 'none', char, sequence: char };
    }

    // Unknown control character
    return { type: 'key', name: `0x${code.toString(16)}`, modifier: 'none', sequence: char };
  }

  /** Parse CSI (ESC [ ... ) sequences. */
  private parseCSI(buffer: string): InputEvent | null {
    // Need at least ESC [ + terminator
    if (buffer.length < 3) return null;
    const terminator = buffer[2]!;

    // Mouse events (SGR: ESC [ < 0 ; row ; col M/m )
    if (terminator === 'M' || terminator === 'm') {
      return this.parseMouse(buffer);
    }

    // Two-character CSI: ESC [ X
    if (buffer.length >= 3 && !this.isParameterChar(terminator)) {
      const seq = buffer.slice(0, 3);
      return this.parseSimpleCSI(terminator, seq);
    }

    // Find the end of the CSI sequence (terminated by a letter in 0x40-0x7E)
    let end = 2;
    while (end < buffer.length) {
      const ch = buffer[end]!;
      const code = ch.charCodeAt(0);
      if (code >= 0x40 && code <= 0x7E) break;
      end++;
    }

    if (end >= buffer.length) return null; // incomplete
    const seq = buffer.slice(0, end + 1);

    // Extract parameters between [ and the terminator
    const params = buffer.slice(2, end).split(';');
    const cmd = seq[seq.length - 1]!;

    return this.parseComplexCSI(cmd, params, seq);
  }

  private isParameterChar(ch: string): boolean {
    const code = ch.charCodeAt(0);
    return (code >= 0x30 && code <= 0x3F) || code === 0x3B; // digits, ; , < = > ?
  }

  /** Parse two-character CSI like ESC [ A (up arrow). */
  private parseSimpleCSI(terminator: string, seq: string): InputEvent {
    const map: Record<string, string> = {
      'A': 'up', 'B': 'down', 'C': 'right', 'D': 'left',
      'H': 'home', 'F': 'end',
    };
    return { type: 'key', name: map[terminator] || terminator, modifier: 'none', sequence: seq };
  }

  /** Parse parameterized CSI like ESC [ 1 ; 5 A (Ctrl+Up). */
  private parseComplexCSI(cmd: string, params: string[], seq: string): InputEvent {
    const p1 = parseInt(params[0] ?? '1', 10);
    const p2 = parseInt(params[1] ?? '1', 10);

    // Determine modifier
    let modifier: KeyModifier = 'none';
    if (p2 === 2) modifier = 'shift';
    else if (p2 === 3) modifier = 'alt';
    else if (p2 === 5) modifier = 'ctrl';
    else if (p2 === 6) modifier = 'ctrl';

    // Map parameter number to key name
    const keyMap: Record<string, Record<number, string>> = {
      '~': {
        1: 'home', 2: 'insert', 3: 'delete', 4: 'end',
        5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end',
        15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8',
        20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12',
      },
      'A': { 1: 'up' },
      'B': { 1: 'down' },
      'C': { 1: 'right' },
      'D': { 1: 'left' },
      'H': { 1: 'home' },
      'F': { 1: 'end' },
    };

    const name = keyMap[cmd]?.[p1] ?? `${cmd}_${params.join('_')}`;
    return { type: 'key', name, modifier, sequence: seq };
  }

  /** Parse ESC + char sequences (Alt+key or F-key). */
  private parseEsc(buffer: string): InputEvent | null {
    const rest = buffer.slice(1);
    const char = rest[0]!;
    const code = char.charCodeAt(0);

    // ESC O P/Q/R/S are F-keys on some terminals
    if (code >= 0x50 && code <= 0x53) {
      const fKeyMap: Record<string, string> = { 'P': 'f1', 'Q': 'f2', 'R': 'f3', 'S': 'f4' };
      return { type: 'key', name: fKeyMap[char] || char, modifier: 'none', sequence: buffer.slice(0, 3) };
    }

    // ESC char = Alt+char
    return { type: 'key', name: char, modifier: 'alt', char, sequence: buffer.slice(0, 2) };
  }

  /** Parse SGR mouse events (ESC [ < A ; B ; C M/m). */
  private parseMouse(buffer: string): MouseEvent | null {
    // SGR mouse: ESC [ < button ; col ; row M (press) / m (release)
    const match = buffer.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (!match) return null;

    const [, btnStr, colStr, rowStr, pressType] = match;
    const buttonCode = parseInt(btnStr!, 10);
    const col = parseInt(colStr!, 10);
    const row = parseInt(rowStr!, 10);
    const isPress = pressType === 'M';

    // Decode button code (SGR encoding)
    const btn = buttonCode & 0x03;
    const shift = !!(buttonCode & 0x04);
    const alt = !!(buttonCode & 0x08);
    const ctrl = !!(buttonCode & 0x10);
    const motion = !!(buttonCode & 0x20); // drag
    const wheel = !!(buttonCode & 0x40);

    let button: 'left' | 'middle' | 'right' | 'none' = 'none';
    if (!wheel) {
      if (btn === 0) button = 'left';
      else if (btn === 1) button = 'middle';
      else if (btn === 2) button = 'right';
    }

    if (wheel && isPress) {
      // Scroll event
      return {
        type: 'mouse',
        event: buttonCode === 65 ? 'scroll_up' : 'scroll_down',
        row, col, button: 'none',
      };
    }

    if (motion && isPress) {
      return { type: 'mouse', event: 'drag', row, col, button };
    }

    if (isPress) {
      return { type: 'mouse', event: 'down', row, col, button };
    }

    return { type: 'mouse', event: 'up', row, col, button };
  }

  // ─── Key Repeat Prevention ──────────────────────────────────────────

  private clearKeyRepeatTimers(): void {
    for (const timer of this.keyRepeatTimers.values()) {
      clearTimeout(timer);
    }
    this.keyRepeatTimers.clear();
  }
}

// ─── Multi-line Text Editor ─────────────────────────────────────────────

export interface EditorState {
  /** Lines of text. */
  lines: string[];
  /** Cursor row (index into lines). */
  row: number;
  /** Cursor column. */
  col: number;
  /** Scroll offset for the viewport. */
  scrollOffset: number;
  /** Prompt string displayed before the text. */
  prompt: string;
}

export function createEditorState(prompt = '> '): EditorState {
  return {
    lines: [''],
    row: 0,
    col: 0,
    scrollOffset: 0,
    prompt,
  };
}

/** Move cursor left by one character. */
export function editorCursorLeft(state: EditorState): void {
  if (state.col > 0) {
    state.col--;
  } else if (state.row > 0) {
    state.row--;
    state.col = state.lines[state.row]!.length;
  }
}

/** Move cursor right by one character. */
export function editorCursorRight(state: EditorState): void {
  if (state.col < state.lines[state.row]!.length) {
    state.col++;
  } else if (state.row < state.lines.length - 1) {
    state.row++;
    state.col = 0;
  }
}

/** Move cursor up one line. */
export function editorCursorUp(state: EditorState): void {
  if (state.row > 0) {
    state.row--;
    state.col = Math.min(state.col, state.lines[state.row]!.length);
  }
}

/** Move cursor down one line. */
export function editorCursorDown(state: EditorState): void {
  if (state.row < state.lines.length - 1) {
    state.row++;
    state.col = Math.min(state.col, state.lines[state.row]!.length);
  }
}

/** Move cursor to beginning of line. */
export function editorHome(state: EditorState): void {
  state.col = 0;
}

/** Move cursor to end of line. */
export function editorEnd(state: EditorState): void {
  state.col = state.lines[state.row]!.length;
}

/** Move cursor to previous word boundary. */
export function editorWordLeft(state: EditorState): void {
  const line = state.lines[state.row]!;
  let c = Math.min(state.col, line.length) - 1;
  // Skip spaces
  while (c > 0 && line[c] === ' ') c--;
  // Skip word
  while (c > 0 && line[c - 1] !== ' ') c--;
  state.col = c;
}

/** Move cursor to next word boundary. */
export function editorWordRight(state: EditorState): void {
  const line = state.lines[state.row]!;
  let c = state.col;
  // Skip current word
  while (c < line.length && line[c] !== ' ') c++;
  // Skip spaces
  while (c < line.length && line[c] === ' ') c++;
  state.col = Math.min(c, line.length);
}

/** Insert a character at the cursor position. */
export function editorInsertChar(state: EditorState, char: string): void {
  const line = state.lines[state.row]!;
  const before = line.slice(0, state.col);
  const after = line.slice(state.col);
  state.lines[state.row] = before + char + after;
  state.col++;
}

/** Insert a newline at the cursor position (splits the line). */
export function editorInsertNewline(state: EditorState): void {
  const line = state.lines[state.row]!;
  const before = line.slice(0, state.col);
  const after = line.slice(state.col);
  state.lines[state.row] = before;
  state.lines.splice(state.row + 1, 0, after);
  state.row++;
  state.col = 0;
}

/** Delete character before cursor (backspace). */
export function editorBackspace(state: EditorState): void {
  if (state.col > 0) {
    const line = state.lines[state.row]!;
    state.lines[state.row] = line.slice(0, state.col - 1) + line.slice(state.col);
    state.col--;
  } else if (state.row > 0) {
    // Join with previous line
    const prevLine = state.lines[state.row - 1]!;
    const curLine = state.lines[state.row]!;
    state.col = prevLine.length;
    state.lines[state.row - 1] = prevLine + curLine;
    state.lines.splice(state.row, 1);
    state.row--;
  }
}

/** Delete character at cursor (delete). */
export function editorDelete(state: EditorState): void {
  const line = state.lines[state.row]!;
  if (state.col < line.length) {
    state.lines[state.row] = line.slice(0, state.col) + line.slice(state.col + 1);
  } else if (state.row < state.lines.length - 1) {
    // Join with next line
    const nextLine = state.lines[state.row + 1]!;
    state.lines[state.row] = line + nextLine;
    state.lines.splice(state.row + 1, 1);
  }
}

/** Get the full text content of the editor. */
export function editorGetText(state: EditorState): string {
  return state.lines.join('\n');
}

/** Clear the editor content. */
export function editorClear(state: EditorState): void {
  state.lines = [''];
  state.row = 0;
  state.col = 0;
  state.scrollOffset = 0;
}

/** Render the editor content as an array of terminal lines. */
export function editorRender(state: EditorState, maxCols: number): string[] {
  const result: string[] = [];

  for (let i = 0; i < state.lines.length; i++) {
    const line = state.lines[i]!;
    const promptStr = i === 0 ? state.prompt : '  ';
    const wrapped = wrapLine(promptStr + line, maxCols);

    if (wrapped.length === 0) {
      result.push(promptStr + ' '.repeat(maxCols - promptStr.length));
    } else {
      result.push(...wrapped);
    }
  }

  // If empty, show the prompt at minimum
  if (result.length === 0) {
    result.push(state.prompt + ' '.repeat(maxCols - state.prompt.length));
  }

  return result;
}

/** Simple word-wrap: split a line into chunks that fit within maxCols. */
function wrapLine(line: string, maxCols: number): string[] {
  if (line.length <= maxCols) return [line];
  const lines: string[] = [];
  for (let i = 0; i < line.length; i += maxCols) {
    lines.push(line.slice(i, i + maxCols));
  }
  return lines;
}