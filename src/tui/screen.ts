/**
 * Screen manager — alternate buffer, resize handling, frame management.
 *
 * Provides:
 *   - Enter/exit alternate screen buffer (full terminal takeover)
 *   - Virtual frame buffer with line-level diffing (zero flicker)
 *   - Terminal resize event forwarding
 *   - Coordinated access to stdout
 */

// ─── ANSI Escape Code Primitives ─────────────────────────────────────────

/** Escape character */
const ESC = '\x1b';

/** CSI (Control Sequence Introducer) */
const CSI = `${ESC}[`;

/** Move cursor to (row, col) — 1-indexed */
export const cursorTo = (row: number, col: number) => `${CSI}${row};${col}H`;

/** Move cursor up N rows */
export const cursorUp = (n = 1) => `${CSI}${n}A`;

/** Move cursor down N rows */
export const cursorDown = (n = 1) => `${CSI}${n}B`;

/** Move cursor right N cols */
export const cursorRight = (n = 1) => `${CSI}${n}C`;

/** Move cursor left N cols */
export const cursorLeft = (n = 1) => `${CSI}${n}D`;

/** Clear from cursor to end of line */
export const clearLine = `${CSI}K`;

/** Clear entire line */
export const clearLineFull = `${CSI}2K`;

/** Clear from cursor to end of screen */
export const clearBelow = `${CSI}J`;

/** Save cursor position */
export const saveCursor = `${ESC}7`;

/** Restore cursor position */
export const restoreCursor = `${ESC}8`;

/** Enable SGR mouse mode (click, scroll, hover) */
export const enableMouse = `${CSI}?1000h${CSI}?1002h${CSI}?1006h`;

/** Disable SGR mouse mode */
export const disableMouse = `${CSI}?1006l${CSI}?1002l${CSI}?1000l`;

/** Show cursor */
export const showCursor = `${CSI}?25h`;

/** Hide cursor */
export const hideCursor = `${CSI}?25l`;

/** Enter alternate screen buffer */
export const enterAltScreen = `${CSI}?1049h`;

/** Exit alternate screen buffer */
export const exitAltScreen = `${CSI}?1049l`;

/** Reset all styling */
export const resetStyle = `${ESC}[0m`;

/** Style helpers */
export const style = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  italic: `${ESC}[3m`,
  underline: `${ESC}[4m`,
  // Foreground
  black: `${ESC}[30m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  magenta: `${ESC}[35m`,
  cyan: `${ESC}[36m`,
  white: `${ESC}[37m`,
  gray: `${ESC}[90m`,
  // Background
  bgBlack: `${ESC}[40m`,
  bgRed: `${ESC}[41m`,
  bgGreen: `${ESC}[42m`,
  bgYellow: `${ESC}[43m`,
  bgBlue: `${ESC}[44m`,
  bgMagenta: `${ESC}[45m`,
  bgCyan: `${ESC}[46m`,
  bgWhite: `${ESC}[47m`,
};

// ─── Screen Class ────────────────────────────────────────────────────────

export interface ScreenSize {
  rows: number;
  cols: number;
}

export interface FrameLine {
  text: string;
  dirty: boolean;
}

/**
 * Virtual screen buffer with line-level dirty tracking.
 * Only writes lines that have changed since last flush.
 */
export class Screen {
  private frame: FrameLine[] = [];
  private _rows = 0;
  private _cols = 0;
  private entered = false;
  private resizeListeners: Array<(rows: number, cols: number) => void> = [];
  private updateRequested = false;

  constructor() {
    this.updateSize();
    // Pre-allocate frame so writes before enter() don't crash
    this.frame = Array.from({ length: this._rows }, () => ({ text: '', dirty: true }));
    process.stdout.on('resize', () => {
      this.updateSize();
      this.resizeListeners.forEach(fn => fn(this._rows, this._cols));
      this.requestFrame();
    });
  }

  /** Enter alternate screen buffer and set up raw output. */
  enter(): void {
    if (this.entered) return;
    this.entered = true;
    process.stdout.write(enterAltScreen + hideCursor + enableMouse);
    this.updateSize();
    this.ensureFrameSize();
    this.markAllDirty();
  }

  /** Exit alternate screen buffer and restore terminal. */
  exit(): void {
    if (!this.entered) return;
    this.entered = false;
    process.stdout.write(disableMouse + showCursor + exitAltScreen);
  }

  get rows(): number { return this._rows; }
  get cols(): number { return this._cols; }

  onResize(fn: (rows: number, cols: number) => void): void {
    this.resizeListeners.push(fn);
  }

  private updateSize(): void {
    this._rows = process.stdout.rows ?? 24;
    this._cols = process.stdout.columns ?? 80;
  }

  /** Mark the entire frame as dirty (full re-render). */
  markAllDirty(): void {
    for (const line of this.frame) {
      line.dirty = true;
    }
  }

  /** Resize the frame buffer to match terminal dimensions. */
  ensureFrameSize(): void {
    const targetRows = this._rows;
    const targetCols = this._cols;
    if (this.frame.length !== targetRows) {
      const old = this.frame;
      this.frame = Array.from({ length: targetRows }, (_, i) => ({
        text: old[i]?.text ?? '',
        dirty: true,
      }));
    }
  }

  /**
   * Write a line into the virtual frame.
   * If the content hasn't changed, it's not marked dirty.
   */
  writeLine(row: number, text: string): void {
    if (row < 0 || row >= this._rows) return;
    const line = this.frame[row]!;
    if (line.text !== text) {
      line.text = text;
      line.dirty = true;
    }
  }

  /** Clear a range of rows. */
  clearRange(startRow: number, endRow: number): void {
    for (let r = startRow; r <= Math.min(endRow, this._rows - 1); r++) {
      this.writeLine(r, '');
    }
  }

  /**
   * Flush all dirty lines to the terminal.
   * Only writes lines that changed — zero flicker for static content.
   */
  flush(): void {
    this.ensureFrameSize();
    let lastRow = -1;

    for (let r = 0; r < this._rows; r++) {
      const line = this.frame[r]!;
      if (!line.dirty) continue;
      const text = line.text.slice(0, this._cols);
      process.stdout.write(cursorTo(r + 1, 1) + text + clearLine);
      line.dirty = false;
      lastRow = r;
    }
  }

  /** Schedule a frame update on next tick (coalesces multiple calls). */
  requestFrame(): void {
    if (this.updateRequested) return;
    this.updateRequested = true;
    setImmediate(() => {
      this.updateRequested = false;
      this.flush();
    });
  }
}