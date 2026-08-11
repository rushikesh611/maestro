/**
 * Interactive dialogs and choice menus.
 *
 * Components:
 *   - ConfirmDialog: yes/no confirmation with colored border
 *   - ChoiceMenu: single-select or multi-select with arrow/mouse navigation
 *   - ExpandableSection: collapsible accordion for large outputs
 */

import { Screen, style, cursorTo, clearLine, hideCursor, showCursor } from '../screen';
import { InputHandler, type InputEvent, type KeyEvent } from '../input';

// ─── Confirm Dialog ────────────────────────────────────────────────────

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  danger?: boolean; // red border instead of yellow
  timeout?: number; // ms, 0 = no timeout
}

/**
 * Shows a confirmation dialog and waits for y/n.
 * Returns true for yes, false for no.
 */
export async function showConfirm(
  screen: Screen,
  input: InputHandler,
  opts: ConfirmDialogOptions,
): Promise<boolean> {
  const rows = screen.rows;
  const cols = screen.cols;
  const boxWidth = Math.min(60, cols - 4);
  const boxHeight = 7;
  const startRow = Math.floor((rows - boxHeight) / 2);
  const startCol = Math.floor((cols - boxWidth) / 2);

  const borderColor = opts.danger ? style.red : style.yellow;
  const border = borderColor + style.bold;
  const reset = style.reset;

  // Draw dialog box
  const topBorder = `┌${'─'.repeat(boxWidth - 2)}┐`;
  const bottomBorder = `└${'─'.repeat(boxWidth - 1)}┘`;

  screen.writeLine(startRow,     ' '.repeat(startCol) + border + topBorder + reset);
  screen.writeLine(startRow + 1, ' '.repeat(startCol) + border + `│${' '.repeat(boxWidth - 2)}│` + reset);
  screen.writeLine(startRow + 2, ' '.repeat(startCol) + border + `│ ${style.bold}${opts.title}${reset}${' '.repeat(boxWidth - 3 - opts.title.length)}│` + reset);
  screen.writeLine(startRow + 3, ' '.repeat(startCol) + border + `│ ${opts.message}${' '.repeat(boxWidth - 3 - opts.message.length)}│` + reset);
  screen.writeLine(startRow + 4, ' '.repeat(startCol) + border + `│   ${style.gray}[y] Yes    [n] No${' '.repeat(boxWidth - 24)}│` + reset);
  screen.writeLine(startRow + 5, ' '.repeat(startCol) + border + `${' '.repeat(boxWidth - 2)}│` + reset);
  screen.writeLine(startRow + 6, ' '.repeat(startCol) + border + bottomBorder + reset);
  screen.flush();

  return new Promise<boolean>(resolve => {
    const handler = (event: InputEvent) => {
      if (event.type !== 'key') return;
      const key = event as KeyEvent;
      const char = key.char?.toLowerCase();

      if (char === 'y' || key.name === 'return') {
        cleanup();
        resolve(true);
      }
      if (char === 'n' || key.name === 'escape') {
        cleanup();
        resolve(false);
      }
    };

    const cleanup = () => {
      input.removeListener('input', handler);
      // Restore the screen area
      for (let r = startRow; r <= startRow + boxHeight; r++) {
        screen.writeLine(r, '');
      }
      screen.flush();
    };

    input.on('input', handler);
  });
}

// ─── Choice Menu ─────────────────────────────────────────────────────────

export interface ChoiceMenuOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface ChoiceMenuOptions {
  prompt: string;
  options: ChoiceMenuOption[];
  multiSelect?: boolean;
  pageSize?: number;
}

export async function showChoiceMenu(
  screen: Screen,
  input: InputHandler,
  opts: ChoiceMenuOptions,
): Promise<string | string[] | null> {
  const cols = screen.cols;
  const pageSize = opts.pageSize || Math.min(opts.options.length, screen.rows - 6);

  let cursor = 0;
  let selected = new Set<number>();
  let pageOffset = 0;
  const isMulti = opts.multiSelect ?? false;
  const result = await new Promise<string | string[] | null>((resolve) => {
    const render = () => {
      // Clear the menu area
      const menuStart = Math.floor(screen.rows / 2) - Math.floor(pageSize / 2);
      for (let r = menuStart; r < menuStart + pageSize + 3; r++) {
        screen.writeLine(r, '');
      }

      // Title
      screen.writeLine(menuStart, ` ${style.bold}${opts.prompt}${style.reset} ${isMulti ? style.gray + '(space to toggle, enter to confirm)' + style.reset : ''}`);

      // Options
      for (let i = 0; i < pageSize; i++) {
        const idx = pageOffset + i;
        if (idx >= opts.options.length) break;
        const opt = opts.options[idx]!;
        const row = menuStart + 2 + i;

        const isCursor = idx === cursor;
        const isSelected = selected.has(idx);
        const check = isSelected ? (isMulti ? '☑' : '●') : (isMulti ? '☐' : '○');
        const cursorMark = isCursor ? style.cyan : ' ';
        const disabled = opt.disabled ? style.gray : '';
        const desc = opt.description ? ` ${style.gray}${opt.description}${style.reset}` : '';
        const cursorArrow = isCursor ? '▸' : ' ';

        screen.writeLine(row, ` ${cursorMark}${cursorArrow}${style.reset} ${check} ${disabled}${opt.label}${desc}${style.reset}${' '.repeat(Math.max(0, cols - opt.label.length - 10))}`);
      }

      // Page indicators
      if (opts.options.length > pageSize) {
        const indicator = ` Page ${Math.floor(pageOffset / pageSize) + 1}/${Math.ceil(opts.options.length / pageSize)} `;
        screen.writeLine(menuStart + pageSize + 2, ` ${style.gray}${indicator}${style.reset}`);
      }

      // Footer hint
      const footer = isMulti ? '↑↓ move · space toggle · enter confirm · esc cancel' : '↑↓ move · enter select · esc cancel';
      screen.writeLine(menuStart + pageSize + 3, ` ${style.gray}${footer}${style.reset}`);
      screen.flush();
    };

    render();

    const handler = (event: InputEvent) => {
      if (event.type === 'mouse') {
        // Handle mouse click on menu items
        const menuStart = Math.floor(screen.rows / 2) - Math.floor(pageSize / 2);
        const itemRow = event.row - menuStart - 2;
        if (itemRow >= 0 && itemRow < pageSize) {
          const idx = pageOffset + itemRow;
          if (idx < opts.options.length && !opts.options[idx]!.disabled) {
            cursor = idx;
            if (isMulti) {
              toggleSelected(idx, selected);
            } else {
              cleanup();
              resolve(opts.options[idx]!.value);
              return;
            }
          }
        }
        render();
        return;
      }

      if (event.type !== 'key') return;
      const key = event as KeyEvent;

      if (key.name === 'up' || key.name === 'down') {
        const dir = key.name === 'up' ? -1 : 1;
        const newCursor = cursor + dir;
        if (newCursor >= 0 && newCursor < opts.options.length) {
          cursor = newCursor;
          // Auto-scroll
          if (cursor < pageOffset) pageOffset = cursor;
          if (cursor >= pageOffset + pageSize) pageOffset = cursor - pageSize + 1;
        }
        render();
        return;
      }

      if (key.name === 'return') {
        if (isMulti) {
          cleanup();
          resolve(Array.from(selected).map(i => opts.options[i]!.value));
          return;
        } else {
          if (!opts.options[cursor]!.disabled) {
            cleanup();
            resolve(opts.options[cursor]!.value);
            return;
          }
        }
        return;
      }

      if (key.name === 'escape') {
        cleanup();
        resolve(null);
        return;
      }

      if (key.name === ' ' && isMulti) {
        toggleSelected(cursor, selected);
        render();
        return;
      }
    };

    const cleanup = () => {
      input.removeListener('input', handler);
    };

    input.on('input', handler);
  });

  return result;
}

function toggleSelected(idx: number, selected: Set<number>): void {
  if (selected.has(idx)) selected.delete(idx);
  else selected.add(idx);
}

// ─── Expandable Section ─────────────────────────────────────────────────

export interface ExpandableSectionOptions {
  title: string;
  content: string;
  collapsed?: boolean;
  maxPreviewLines?: number;
}

export class ExpandableSection {
  private collapsed: boolean;
  private content: string;
  private title: string;
  private maxPreviewLines: number;

  constructor(opts: ExpandableSectionOptions) {
    this.collapsed = opts.collapsed ?? true;
    this.content = opts.content;
    this.title = opts.title;
    this.maxPreviewLines = opts.maxPreviewLines ?? 10;
  }

  toggle(): void {
    this.collapsed = !this.collapsed;
  }

  render(screen: Screen, startRow: number): number {
    const indicator = this.collapsed ? '▶' : '▼';
    const lines = this.content.split('\n');
    const previewLines = this.collapsed ? lines.slice(0, this.maxPreviewLines) : lines;
    const truncated = this.collapsed && lines.length > this.maxPreviewLines;

    screen.writeLine(startRow, ` ${style.cyan}${indicator}${style.reset} ${style.bold}${this.title}${style.reset} ${style.gray}(${lines.length} lines)${style.reset}`);
    let row = startRow + 1;

    for (const line of previewLines) {
      screen.writeLine(row, `   ${style.gray}${line.slice(0, screen.cols - 4)}${style.reset}`);
      row++;
      if (row >= screen.rows - 2) break; // Don't overflow
    }

    if (truncated) {
      screen.writeLine(row, `   ${style.gray}… ${lines.length - this.maxPreviewLines} more lines (click to expand)${style.reset}`);
      row++;
    }

    return row - startRow;
  }
}