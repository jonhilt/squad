# Claude Code Adapter for Squad — Implementation Plan

## Goal
Replace `@github/copilot-sdk` with `claude` CLI subprocess in Squad's adapter layer, enabling Squad to orchestrate Claude Code agents instead of Copilot.

## Architecture Decisions

- **CLI subprocess** (`claude -p --output-format stream-json --verbose`), not Agent SDK
- Short-lived processes per message, resumed via `--resume <session-id>`
- User's existing Anthropic subscription via `claude` CLI auth
- **Sessions**: tracked in `.squad/sessions/` (Squad's own registry)
- **Concurrency**: configurable, test empirically to find subscription limits
- **Hooks**: CC handles safety/permissions natively; Squad pipeline handles orchestration-level policies only (reviewer lockout, cross-agent coordination, ask_user rate limiting)
- **Models**: CC aliases directly in charters (`model: sonnet`, `model: opus`, `model: haiku`)
- **Timeouts**: 10 minute default per agent invocation
- **Output**: stream-json (real-time NDJSON parsing for live monitoring + early abort)

## Key CLI Primitives

| Squad Concept | CC CLI Equivalent |
|---------------|-------------------|
| Create session | `claude -p --session-id <uuid> --output-format stream-json --verbose` |
| Resume session | `claude -p --resume <session-id> --output-format stream-json --verbose` |
| Send message | Pipe prompt to stdin with `--print` |
| Streaming events | `--output-format stream-json --verbose` (NDJSON on stdout) |
| Model selection | `--model sonnet` / `--model opus` / `--model haiku` |
| System prompt | `--system-prompt "..."` or `--append-system-prompt "..."` |
| Tool control | `--allowedTools "Bash Edit Read"` / `--disallowedTools "..."` |
| Permission mode | `--permission-mode auto` / `bypassPermissions` / `default` |
| Working directory | `cd <dir> &&` before command, or `--add-dir` |
| Abort | Kill subprocess (SIGTERM) |
| MCP servers | `--mcp-config <path>` |
| Worktree isolation | `--worktree` |
| Timeout | 10 min default, enforced by orchestrator (kill process) |

## Hook Responsibility Split

| Concern | Owner | Mechanism |
|---------|-------|-----------|
| Blocked commands (rm -rf, force push) | CC | `.claude/settings.json` PreToolUse hooks |
| File-write guards | CC | `.claude/settings.json` PreToolUse hooks |
| Secret leak prevention | CC | `.claude/settings.json` PreToolUse hooks |
| Permission gating | CC | `--permission-mode` flag |
| Reviewer lockout | Squad | HookPipeline (orchestrator-level, cross-session) |
| PII scrubbing on output | Squad | PostToolUse in orchestrator (inspects stream events) |
| Cross-agent coordination | Squad | EventBus + orchestrator |
| ask_user rate limiting | Squad | HookPipeline (per-session counter) |
| Post-commit history | Git | `.git/hooks/post-commit` → `.squad/hooks/post-commit.sh` |

## What Changes

### New Files (in `packages/squad-sdk/src/adapter/`)

1. **`claude-code-client.ts`** — `ClaudeCodeClient`
   - `connect()` → verify `claude --version` exists, no persistent server needed
   - `disconnect()` → kill any running subprocesses
   - `createSession()` → generate UUID, spawn `claude -p --session-id <uuid>`, return `ClaudeCodeSession`
   - `resumeSession()` → spawn `claude -p --resume <id>`
   - `listSessions()` → read from `.squad/sessions/` registry
   - `getAuthStatus()` → parse `claude auth status` output
   - `deleteSession()` → remove from `.squad/sessions/` registry
   - `ping()` → `claude --version` check

2. **`claude-code-session.ts`** — `ClaudeCodeSession implements SquadSession`
   - `sendMessage()` → spawn `claude -p --resume <id> --output-format stream-json --verbose`, pipe prompt to stdin
   - Parse NDJSON stream line-by-line → emit `SquadSessionEvent` via EventEmitter
   - `on()` / `off()` → Node EventEmitter pattern
   - `close()` → kill subprocess if running, update `.squad/sessions/` status
   - `abort()` → SIGTERM subprocess
   - `sendAndWait()` → spawn, collect stream, resolve on `result` event, reject on timeout (10 min)
   - `getMessages()` → not implemented initially (return [])

3. **`claude-code-event-mapper.ts`** — Maps CC stream-json → Squad events
   - `{"type":"assistant","message":{"content":[{"type":"text",...}]}}` → `message` / `message_delta`
   - `{"type":"result",...}` → `turn_end` + `idle` + `usage`
   - `{"type":"system","subtype":"init",...}` → session metadata capture
   - `{"type":"system","subtype":"hook_response",...}` → log/ignore
   - Extract `usage.input_tokens`, `usage.output_tokens` → `usage` event
   - Extract `total_cost_usd` → cost tracking

4. **`claude-code-session-registry.ts`** — `.squad/sessions/` manager
   - `register(sessionId, agentName, model)` → write JSON to `.squad/sessions/<id>.json`
   - `update(sessionId, status)` → update status field
   - `list()` → read all session files
   - `remove(sessionId)` → delete file
   - Session file schema: `{ id, agentName, model, status, createdAt, lastActivityAt }`

### Modified Files

5. **`adapter/client.ts`** → Add factory function
   - `createSquadClient(backend: 'copilot' | 'claude-code', options)` → returns appropriate client
   - Existing `SquadClient` class untouched (backward compat)

6. **`adapter/types.ts`** → Minor additions
   - Add `backend?: 'copilot' | 'claude-code'` to config
   - Add CC-specific options: `permissionMode`, `effortLevel`, `allowedTools`, `disallowedTools`

7. **`.squad/config.json`** → Backend selector
   - `"backend": "claude-code"` (new field, default: `"copilot"`)

8. **`cli/commands/start.ts`** → PTY backend detection
   - When `backend === 'claude-code'`, spawn `claude` binary in PTY instead of `copilot`

9. **`agents/model-selector.ts`** → CC model passthrough
   - When backend is `claude-code`, pass model aliases directly (`sonnet`, `opus`, `haiku`)
   - No mapping needed — charters use CC aliases directly

### Untouched (zero changes)

- `coordinator/coordinator.ts` — routes via SquadSession interface
- `coordinator/fan-out.ts` — parallel spawning via interface
- `agents/lifecycle.ts` — lifecycle via SquadSession interface
- `agents/charter-compiler.ts` — compiles charter.md → system prompt string
- `hooks/index.ts` — HookPipeline (used at orchestrator level only)
- `runtime/event-bus.ts` — generic pub/sub
- `client/session-pool.ts` — pool management via SquadSession
- All `.squad/` convention files

## Implementation Phases

### Phase 1: Tracer Bullet (Single Agent, One-Shot)
1. `claude-code-event-mapper.ts` — parse stream-json, map to Squad events
2. `claude-code-session.ts` — spawn `claude -p`, parse NDJSON, implement `sendAndWait()`
3. `claude-code-client.ts` — minimal: `connect()` (version check) + `createSession()`
4. `claude-code-session-registry.ts` — basic register/update
5. Smoke test: create session, send prompt, get result back, verify events emitted
- **Exit criterion**: one CC agent processes a prompt and returns a structured result through Squad's interfaces

### Phase 2: Streaming + Multi-Turn
1. Wire real-time NDJSON parsing with event emission (message_delta as it arrives)
2. Implement `--resume <session-id>` for multi-turn conversations
3. Wire `abort()` → SIGTERM with graceful cleanup
4. Implement 10-minute timeout with process kill
5. Verify: send 3 messages to same session, get coherent multi-turn responses
- **Exit criterion**: live streaming events visible to coordinator, multi-turn works

### Phase 3: Multi-Agent Coordination
1. Wire `ClaudeCodeClient` into `AgentLifecycleManager`
2. Wire into coordinator fan-out (parallel `claude -p` processes)
3. Charter compilation → `--system-prompt` or `--append-system-prompt`
4. Model passthrough in model-selector
5. Concurrency testing: 2, 3, 4 parallel agents — find rate limits
6. Verify: spawn 2+ agents with different charters, route messages, get coordinated output
- **Exit criterion**: multi-agent task completes with agents running in parallel

### Phase 4: PTY Mode (squad start)
1. `start.ts` — detect `backend: "claude-code"`, spawn `claude` in PTY
2. Remote bridge (WebSocket mirror) works as-is — terminal-agnostic
3. Verify: `squad start` opens interactive Claude Code session with remote mirror
- **Exit criterion**: `squad start` launches Claude Code in PTY with remote access working

### Phase 5: Polish + Orchestrator Hooks
1. Squad HookPipeline wiring for orchestrator-level concerns (reviewer lockout, PII scrubbing)
2. Tool filtering passthrough (`--allowedTools` / `--disallowedTools`)
3. MCP server passthrough (`--mcp-config`)
4. Error mapping (CC errors → Squad error hierarchy)
5. Cost tracking aggregation from `result.total_cost_usd`
6. Session registry cleanup (stale session pruning)
7. Tests for adapter layer
- **Exit criterion**: production-quality adapter with error handling and tests
