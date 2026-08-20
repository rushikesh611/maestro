/**
 * TUI layer using @earendil-works/pi-tui library.
 *
 * Layout:
 *   TuiAltScreen
 *    └─ VStack (fills height)
 *         ├─ ScrollView (output, follows end)
 *         │   └─ VStack (Text/Markdown components)
 *         └─ Editor (border + input, auto-sized)
 *
 * Editor renders with a clean border (─) and shows autocomplete
 * popup when typing / or @.
 */

import { EventEmitter } from 'events';
import {
  ProcessTerminal,
  TuiAltScreen,
  Text,
  Markdown,
  VStack,
  ScrollView,
  Editor,
  Spacer,
  CombinedAutocompleteProvider,
  type SlashCommand,
  type Component,
  type MarkdownTheme,
} from '@earendil-works/pi-tui';

export interface OutputEntry {
  type: 'system' | 'user' | 'assistant' | 'tool' | 'error' | 'divider' | 'result';
  text?: string;
}

// ─── Themes ──────────────────────────────────────────────────────────────

const editorTheme = {
  borderColor: (str: string) => `\x1b[90m${str}\x1b[0m`,
  selectList: {
    selectedPrefix: (s: string) => `\x1b[36m▸ ${s}\x1b[0m`,
    selectedText: (s: string) => `\x1b[36m${s}\x1b[0m`,
    description: (s: string) => `\x1b[90m${s}\x1b[0m`,
    scrollInfo: (s: string) => `\x1b[90m${s}\x1b[0m`,
    noMatch: (s: string) => `\x1b[90mNo matches\x1b[0m`,
  },
};

const markdownTheme: MarkdownTheme = {
  heading: (s: string) => `\x1b[1;36m${s}\x1b[0m`,
  link: (s: string) => `\x1b[34;4m${s}\x1b[0m`,
  linkUrl: (s: string) => `\x1b[34m${s}\x1b[0m`,
  code: (s: string) => `\x1b[33m${s}\x1b[0m`,
  codeBlock: (s: string) => `\x1b[90m${s}\x1b[0m`,
  codeBlockBorder: (s: string) => `\x1b[90m${s}\x1b[0m`,
  quote: (s: string) => `\x1b[90m${s}\x1b[0m`,
  quoteBorder: (s: string) => `\x1b[90m${s}\x1b[0m`,
  hr: (s: string) => `\x1b[90m${s}\x1b[0m`,
  listBullet: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  italic: (s: string) => `\x1b[3m${s}\x1b[0m`,
  strikethrough: (s: string) => `\x1b[9m${s}\x1b[0m`,
  underline: (s: string) => `\x1b[4m${s}\x1b[0m`,
};

// ─── TUI Class ───────────────────────────────────────────────────────────

export class TUI extends EventEmitter {
  readonly tui: TuiAltScreen;
  private scrollView: ScrollView;
  private outputVStack: VStack;
  private editor: Editor;
  private running = false;
  promptActive = false;
  /** Resolve callback for the currently-active promptUser call. */
  private pendingPromptResolve: ((value: string) => void) | null = null;
  /** Echo line component for the currently-active prompt. */
  private echoLine: Text | null = null;

  constructor() {
    super();
    const terminal = new ProcessTerminal();

    this.tui = new TuiAltScreen(terminal, true, undefined, { mouse: true });

    // Output: scrollable list of Text/Markdown components
    this.outputVStack = new VStack();
    this.scrollView = new ScrollView(this.outputVStack, {
      follow: 'end',
      scrollbar: 'auto',
      scrollbarStyle: (s: string) => `\x1b[90m${s}\x1b[0m`,
    });

    // Editor with clean border theme
    this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
    this.editor.onSubmit = (text: string) => {
      // Route to active promptUser if one is waiting
      if (this.promptActive && this.pendingPromptResolve) {
        const resolve = this.pendingPromptResolve;
        this.pendingPromptResolve = null;
        this.promptActive = false;
        this.echoLine?.setText(`\x1b[90m  ✓ ${text}\x1b[0m`);
        this.tui.renderNow();
        // Re-disable Editor if agent still running
        this.editor.disableSubmit = this.running;
        resolve(text);
        return;
      }
      if (this.running) return;
      this.outputVStack.addChild(new Text(`\x1b[36m│ ${text}\x1b[0m`, 0, 0));
      this.scrollView.scrollToEnd();
      this.emit('submit', text);
    };

    // Layout
    const layout = new VStack();
    layout.addChild(this.scrollView);
    layout.addChild(this.editor);
    this.tui.setLayoutRoot(layout);
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /** Set or update slash commands for the autocomplete popup. */
  setAutocompleteCommands(commands: { name: string; description: string }[]): void {
    const slashCmds: SlashCommand[] = commands.map(c => ({
      name: c.name.replace(/^\//, ''),
      description: c.description,
    }));
    const provider = new CombinedAutocompleteProvider(slashCmds, process.cwd());
    this.editor.setAutocompleteProvider(provider);
  }

  start(): void {
    // Autocomplete was already configured via setAutocompleteCommands() before start()
    this.tui.start();
    this.tui.setFocus(this.editor);

    // Ctrl+C: require two presses within 2 seconds to exit
    let sigintCount = 0;
    let sigintTimer: ReturnType<typeof setTimeout> | null = null;

    this.tui.addInputListener((data: string) => {
      if (data === '\x03') {
        sigintCount++;
        if (sigintCount === 1) {
          this.appendOutput({ type: 'system', text: '\x1b[33m⚠️  Press Ctrl+C again within 2s to exit.\x1b[0m' });
          if (sigintTimer) clearTimeout(sigintTimer);
          sigintTimer = setTimeout(() => { sigintCount = 0; sigintTimer = null; }, 2000);
        } else {
          if (sigintTimer) clearTimeout(sigintTimer);
          this.stop();
          process.exit(0);
        }
        return { consume: true };
      }
      return { consume: false };
    });

    this.tui.renderNow();
  }

  stop(): void { this.tui.stop(); }

  appendOutput(...entries: OutputEntry[]): void {
    for (const entry of entries) {
      switch (entry.type) {
        case 'divider':
          this.outputVStack.addChild(new Text(''));
          break;
        case 'result':
          // Render agent results as Markdown (code blocks, lists, etc.)
          if (entry.text) {
            this.outputVStack.addChild(new Markdown(
              entry.text, 0, 0, markdownTheme, undefined, { preserveOrderedListMarkers: true }
            ));
          }
          break;
        case 'error':
          if (entry.text) this.outputVStack.addChild(new Text(`\x1b[31m${entry.text}\x1b[0m`, 0, 0));
          break;
        default:
          if (entry.text) this.outputVStack.addChild(new Text(entry.text, 0, 0));
      }
    }
    this.scrollView.scrollToEnd();
    this.tui.renderNow();
  }

  clearOutput(): void {
    this.outputVStack = new VStack();
    this.scrollView.clear();
    this.scrollView.addChild(this.outputVStack);
    this.tui.renderNow();
  }

  setRunning(running: boolean): void {
    this.running = running;
    this.editor.disableSubmit = running;
  }

  /** Prompt for a line of text during agent execution.
   *  Uses the main Editor for input — user types in the Editor area
   *  and presses Enter to submit. No separate input listener. */
  promptUser(question: string): Promise<string> {
    this.outputVStack.addChild(new Text(`\x1b[33m⏸ ${question}\x1b[0m`));
    this.echoLine = new Text(`\x1b[36m  > \x1b[0m`, 0, 0);
    this.outputVStack.addChild(this.echoLine);
    this.scrollView.scrollToEnd();
    this.tui.renderNow();
    this.promptActive = true;
    // Enable Editor so user can type response (may be disabled by setRunning)
    this.editor.disableSubmit = false;

    return new Promise(resolve => {
      this.pendingPromptResolve = resolve;
    });
  }

  /** Yes/no confirmation prompt. */
  async confirm(question: string, _danger = false): Promise<boolean> {
    this.outputVStack.addChild(new Text(`\x1b[33m🔒 ${question}\x1b[0m`));
    this.outputVStack.addChild(new Text(`  \x1b[90m[y] Yes    [n] No\x1b[0m`));
    this.tui.renderNow();
    this.promptActive = true;

    return new Promise(resolve => {
      const remove = this.tui.addInputListener((data: string) => {
        const ch = data.toLowerCase().trim();
        if (ch.startsWith('/')) {
          // Slash command typed during confirm — release prompt lock and pass command to editor
          this.echoLine = new Text(`\x1b[90m  ↪ Slash command — skipped\x1b[0m`, 0, 0);
          this.outputVStack.addChild(this.echoLine);
          this.tui.renderNow();
          remove(); this.promptActive = false; resolve(false);
          return { consume: false };
        }
        if (ch === 'y' || ch === '\r' || ch === '\n' || ch === 'yes') {
          this.echoLine = new Text(`\x1b[32m  ✓ Approved\x1b[0m`, 0, 0);
          this.outputVStack.addChild(this.echoLine);
          this.scrollView.scrollToEnd();
          this.tui.renderNow();
          remove(); this.promptActive = false; resolve(true);
          return { consume: true };
        }
        if (ch === 'n' || ch === '\x1b' || ch === 'no') {
          this.echoLine = new Text(`\x1b[31m  ✘ Denied\x1b[0m`, 0, 0);
          this.outputVStack.addChild(this.echoLine);
          this.scrollView.scrollToEnd();
          this.tui.renderNow();
          remove(); this.promptActive = false; resolve(false);
          return { consume: true };
        }
        return { consume: false };
      });
    });
  }

  waitForSubmit(): Promise<string> {
    return new Promise(resolve => {
      const handler = (text: string) => {
        this.removeListener('submit', handler);
        resolve(text);
      };
      this.on('submit', handler);
    });
  }
}