# Maestro – OpenRouter‑Powered SRE Agent

**Maestro** is a thin, opinionated REPL layer built on top of **OpenRouter**. It turns the prompt‑based interface into a full‑featured terminal where you can run specialized agents, pause execution to ask the user for input, and attach to running tasks for interactive debugging.

- **Tag‑based agent selection:** refer to agents by a short `@name` tag (e.g., `@sre status`).
- **Background tasks:** submit a task to run asynchronously; receive a task‑ID back and monitor progress via structured events.
- **Pause & resume:** agents can call `wait_for_input` and the task pauses until you send input via `/send <task-id> <input>`.
- **Interactive session:** use `/attach <task-id>` to enter a task‑specific REPL, view live streaming output, and interact with paused tasks.
- **Live event streaming:** watch `task:output`, `task:log`, and `task:status` events with `/events <task-id>`.
- **Full conversation view:** inspect every message and tool call that an agent has produced with `/view <task-id>`.
- **Plugin‑friendly:** new agents and tools are automatically discovered from `src/agents/` and `src/tools/` (and from plugins).

## 🚀 Quick Start

### 1️⃣ Installation
```bash
bun install          # install dependencies
```

### 2️⃣ Running the REPL
```bash
bun run src/index.ts    # start the Maestro REPL
```

### 3️⃣ Basic usage
- **Submit a background task**
  ```text
  /bg "npm install"
  ```
  You receive a task‑ID (e.g., `a7f2`).

- **List background jobs**
  ```text
  /tasks
  ```

- **View a task’s conversation & output**
  ```text
  /view a7f2
  ```

- **Send input to a waiting task**
  ```text
  /send a7f2 "/etc/nginx/nginx.conf"
  ```

- **Attach to a task for interactive debugging**
  ```text
  /attach a7f2
  ```
  Inside the task’s sub‑REPL you can send more prompts, see live output, and type `detach` (or `exit`) to return to the main prompt.

- **Stream live events (10 s)**
  ```text
  /events a7f2
  ```

- **Tag an agent in the main prompt**
  ```text
  @sre status
  ```
  (Any `@agent-name` tag routes to that agent – see `/agents` for available agents.)

---

## 📁 Project Layout

| Directory | Contents |
|-----------|----------|
| `src/core/` | Core types, LLM client (`src/core/llm.ts`), TaskRunner, Agent state machine, Memory store. |
| `src/tools/` | Built‑in tools (`exec`, `read_file`, `write_file`, `web_fetch`, `think`, `wait_for_input`). |
| `src/agents/` | Agent definitions (`.md` files with `name`, `description`, `systemPrompt`). |
| `src/skills/` | Markdown‑based skills that are RAG‑selected and injected into system prompts. |
| `src/mcp/` | Model‑Context‑Protocol connector for external tools. |
| `src/index.ts` | Main REPL, slash‑command router, and the `attachToTask` sub‑REPL implementation. |

---

## 🔧 Features in Detail

### Agent Tagging
```text
@<agent-name> <prompt>
```
The tag is parsed by the REPL’s line‑parser and routed to the matching `AgentDef`.

### Background Tasks & Event Streaming
The `TaskRunner` stores a `TaskRecord` per background job, tracks its status (`queued`, `running`, `waiting`, `completed`, `failed`, `cancelled`), and emits structured events:

- `task:output` – assistant message or tool result
- `task:log` – logs emitted by the runner or tools
- `task:status` – status change (`running`, `waiting`, `completed`, etc.)
- `task:waiting` – agent called `wait_for_input` and is waiting for user input

Clients (`/events`, `/view`, `/attach`) subscribe to these events for live updates.

### Pausing with `wait_for_input`
Any agent can call the built‑in `wait_for_input` tool:

```typescript
{ "name": "wait_for_input", "arguments": "{\"question\": \"Which endpoint?\"}" }
```

This blocks the agent until the user invokes `/send <task-id> <input>`.

### Attaching to a Task
`attachToTask(taskId)` opens a sub‑REPL with prompt `task-<id> >`.  
All typed lines are sent to that task:

- If the task is **waiting** → the line is forwarded as user input (resumes the task).  
- If the task is **running/fresh** → the line is submitted as a new user prompt.  
Output from the task streams in real‑time, and you can `detach` (or `exit`) to return to the main prompt.

### CLI Commands
All commands start with `/` and are parsed by the REPL’s slash‑router.

| Command | Alias(es) | Description |
|---------|-----------|-------------|
| `/bg <prompt>` | `/submit <prompt>` | Submit a task in background (main agent). |
| `/tasks` | `/jobs` | List all background tasks. |
| `/view <task-id>` | `/attach <task-id>` | Show full conversation & status; open interactive session. |
| `/send <task-id> <input>` | – | Send input to a waiting task. |
| `/detach` | – | Leave the current sub‑REPL. |
| `/events <task-id>` | – | Stream events (10 s) for live debugging. |
| `/cancel <task-id>` | – | Cancel a running/failed task. |
| `/assign @<agent> <task>` | `/assign-bg @<agent> <task>` | Manually assign a task to a named agent (sync/bg). |
| `/agents` | `/list-agents` | List available agents (by name). |
| `/reload` | – | Reload plugins and tool definitions. |
| `/help` | – | Print full command list. |

### Plugin System
Directories matching `plugins/<plugin-name>/` with `skills/`, `agents/`, `tools/` (or `plugin.json`) are automatically discovered and added to the global skill/agent/tool lists.

---

## 🧪 Testing

```bash
bun test          # run the full test suite (68 tests, all pass)
```

| Test file | Coverage |
|-----------|----------|
| `tests/core/task-runner.test.ts` | Task submission, waiting, send, events, cancellation. |
| `tests/core/spawn.test.ts` | Shared `spawnAgent` helper and tag parsing. |
| `tests/tools/spawn-agent.test.ts` | `wait_for_input` tool behavior. |
| `tests/tools/exec.test.ts` | Shell command execution. |
| `tests/tools/truncator.test.ts` | Output truncation. |
| `tests/tools/spawn-agent.test.ts` | Original `spawn_agent` tool behavior. |

All tests pass with `bun test` and type‑check passes with `bunx tsc --noEmit`.

---

## 📖 How It Works

1. **Startup** – `main()` reads env vars, creates an LLM client (OpenRouter), loads skills/agents/tools, and constructs a global `AgentState` representing the **main** agent.
2. **REPL loop** – `runRepl()` presents a prompt `> `; input is parsed for slash commands or `@<agent>` tags.
3. **Tag routing** – `@agent-name` tags are routed via `spawnAgent` to the matching `AgentDef` (sync or background if `/bg` / `/async` suffix is present).
4. **Background tasks** – `/bg` submits a `TaskRecord` to `TaskRunner.submitTask`, which kicks off `executeTask` in a microtask. `executeTask` calls `runAgent` on a copy of the original `AgentState` that includes a reference to the `TaskRunner`.
5. **Agent execution** – `runAgent` fetches memory, skills, and relevant context; emits `task:output` events; and blocks on `wait_for_input` when the tool is called.
6. **Events** – The `TaskRunner` forwards all events to subscribers (`/events`, `/attach`).
7. **User input** – `/send <task-id> <input>` calls `TaskRunner.sendInput`, which resolves the waiting promise, and the agent resumes.

---

## 🏗️ Architecture Decisions

- **OpenRouter‑first** – The project uses OpenRouter as the LLM gateway, supporting any model OpenRouter exposes. Switching providers is a matter of changing `config.baseURL` and `LLM_MODEL` in `.env`.
- **Minimal runtime** – All core logic lives in TypeScript; no heavy frameworks or runtime containers.
- **Test‑first** – Every new feature (waiting, events, attach/detach) has comprehensive unit tests before being wired into the REPL.
- **Plugin‑agnostic** – New agents/tools can be added without touching the core code; only `.md` or `.ts` files in plugin directories are required.

---

## 🛠️ Contributing Guidelines

1. Fork & create a feature branch.  
2. Add tests for any new behavior (existing tests all pass).  
3. Run `bun test` – all tests must pass.  
4. Submit a PR with a clear description and linked tests.

Please adhere to the existing code style (ES2022, strict types) and keep changes minimal.

---

### TL;DR – Command cheat‑sheet

| Command | Example |
|---------|---------|
| `/bg "npm install"` | Spawn background task |
| `/tasks` | List jobs |
| `/view a7f2` | Show conversation output |
| `/send a7f2 "/etc/config"` | Resume a waiting task |
| `/attach a7f2` | Enter interactive sub‑REPL |
| `/detach` | Return to main prompt |
| `/events a7f2` | Stream live events (10 s) |
| `/assign @sre status` | Directly invoke an agent |
| `@linux-expert/logs` | Tag agent in main prompt |

