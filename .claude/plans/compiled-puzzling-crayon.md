# Plan: Terminal UX Overhaul — Tab Completion, Inline Editing, Input Queuing

## Context
The terminal experience doesn't match Claude Code's polish:
- Tab completion doesn't work on Windows terminals (Git Bash)
- Arrow-key editing and cursor navigation don't work (raw mode not properly enabled)
- Input typed while the agent is running disappears silently (no queuing indicator)
- No "Queued" or visual feedback when input is buffered during LLM execution

## Root Causes

### Tab completion dead
Readline's built-in `completer` relies on readline internally intercepting Tab.
On Windows terminals (especially Git Bash), readline doesn't reliably intercept Tab
in cooked mode. The `completer` function is defined but never actually invoked by
the runtime.

### No inline editing
Readline needs raw mode (`process.stdin.setRawMode(true)`) to process individual
keystrokes for backspace, arrow keys, Home/End. While `terminal: true` in
`createInterface` should set this, it's unreliable on Windows Git Bash because
readline detects the terminal differently there.

### No input queuing
The REPL uses `while(true) { await ask('> '); ... await runAgent(...) }`. During
`runAgent()`, the event loop is in an async function call — stdin data is buffered
by Node.js but no visual indicator shows that input was received. When the
agent finishes, `ask()` is called again and the buffered data fires as the "next"
line, but without any context that it was previously queued.

## Implementation Plan

### 1. Keypress-based Tab Completion
Replace the readline `completer` with a direct keypress event handler:
- Enable `readline.emitKeypressEvents(process.stdin)`
- Set raw mode explicitly before creating readline
- Listen for `keypress` events with `key.name === 'tab'`
- On Tab: compute completions from the current `rl.line`
  - If one match: clear line (`^U`) and write the completed text
  - If multiple matches: show them above the prompt via `printAbove`
  - If no match: show "No completions" message

### 2. Enable Raw Mode for Inline Editing
```ts
if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
}
readline.emitKeypressEvents(process.stdin);
```
This enables raw mode BEFORE readline creates its interface, ensuring
individual keystrokes (arrows, Home, End, Ctrl+A, Ctrl+E) reach readline.

### 3. Event-Driven REPL with Input Queuing
Replace the `while(true) { await ask() }` loop with:
```ts
let replBusy = false;
let inputQueue: string[] = [];

rl.on('line', (line) => {
    if (replBusy) {
        const trimmed = line.trim();
        if (trimmed) {
            inputQueue.push(trimmed);
            printAbove(`\x1b[90m📥 Queued (${inputQueue.length})\x1b[0m`);
        }
        rl.prompt();
        return;
    }
    processLine(line);
});
```
After `handleInput()` (which runs `runAgent()`), the handler checks `inputQueue`
and processes the next item if one exists, showing `▶ Processing queued...`.

### 4. Better Status Indicators
- "🤔 Working..." → persists as a banner while the agent runs
- "📥 Queued (N)" → shown above the prompt when input is queued
- "▶ Processing queued input..." → shown when dequeuing
- "✓ Completed (Xs)" → shown when agent finishes

## Files to Modify

### `src/index.ts` (major rewrite of terminal setup + REPL)
- Replace readline `createInterface` options (remove `completer`, add raw mode)
- Replace `runRepl()` while-loop with `rl.on('line')` event-driven handler
- Add `process.stdin.setRawMode(true)` + `readline.emitKeypressEvents()`
- Add Tab keypress handler for completion
- Add input queue array + indicator logic
- Keep `ask()` for approval prompts (works alongside `on('line')`)

### `src/tools/built-in.ts` (minor)
- The `wait_for_input` handler currently creates a nested readline interface for
  sync agents. With raw mode properly enabled, it should work more reliably.

## Verification
1. `bun test` — all 68+ tests must pass
2. `bunx tsc --noEmit` — no type errors
3. Manual test: Tab completion works on `/`, `@`
4. Manual test: Arrow keys navigate within typed text
5. Manual test: Typing during agent execution shows "Queued" indicator
6. Manual test: Queued input is auto-processed after agent finishes