/**
 * Claude Code Client
 *
 * Implements the same interface as SquadClient but backed by the `claude` CLI
 * instead of `@github/copilot-sdk`. No persistent server process — each
 * session interaction spawns a short-lived `claude -p` subprocess.
 *
 * @module adapter/claude-code-client
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type {
  SquadSession,
  SquadSessionConfig,
  SquadSessionMetadata,
  SquadGetStatusResponse,
  SquadGetAuthStatusResponse,
  SquadModelInfo,
  SquadMessageOptions,
  SquadSessionEvent,
  SquadSessionEventHandler,
  SquadClientEventType,
  SquadClientEvent,
  SquadClientEventHandler,
} from './types.js';
import { ClaudeCodeSession, type ClaudeCodeSessionOptions } from './claude-code-session.js';
import { ClaudeCodeSessionRegistry } from './claude-code-session-registry.js';
import { appendToHistory } from '../agents/history-shadow.js';
import { SDKConnectionError, AuthenticationError, ConfigurationError } from './errors.js';
import { trace, SpanStatusCode } from '../runtime/otel-api.js';

const execFileAsync = promisify(execFile);
const tracer = trace.getTracer('squad-sdk');

export type ClaudeCodeConnectionState = 'disconnected' | 'connected' | 'error';

export interface ClaudeCodeClientOptions {
  /** Working directory for claude processes */
  cwd?: string;
  /** Path to the squad root (for session registry) */
  squadRoot?: string;
  /** Default model alias */
  defaultModel?: string;
  /** Default permission mode */
  defaultPermissionMode?: 'acceptEdits' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan' | 'auto';
  /** Default timeout in ms */
  defaultTimeoutMs?: number;
  /** MCP config file path */
  mcpConfig?: string;
}

/**
 * Squad client backed by Claude Code CLI.
 *
 * Usage mirrors SquadClient:
 * ```typescript
 * const client = new ClaudeCodeClient({ squadRoot: '/path/to/project' });
 * await client.connect();  // verifies claude CLI is available
 *
 * const session = await client.createSession({ model: 'sonnet' });
 * await session.sendMessage({ prompt: 'Hello' });
 * await session.close();
 * ```
 */
export class ClaudeCodeClient {
  private state: ClaudeCodeConnectionState = 'disconnected';
  private cliVersion: string | null = null;
  private readonly options: Required<Pick<ClaudeCodeClientOptions, 'cwd'>> & ClaudeCodeClientOptions;
  private readonly registry: ClaudeCodeSessionRegistry;
  private readonly activeSessions = new Map<string, ClaudeCodeSession>();
  private readonly clientEventHandlers = new Set<SquadClientEventHandler>();

  constructor(options: ClaudeCodeClientOptions = {}) {
    this.options = {
      cwd: options.cwd ?? process.cwd(),
      ...options,
    };
    this.registry = new ClaudeCodeSessionRegistry(options.squadRoot ?? this.options.cwd);
  }

  getState(): ClaudeCodeConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Verify that the claude CLI is available and authenticated.
   * No persistent server to start — this just validates the environment.
   */
  async connect(): Promise<void> {
    const span = tracer.startSpan('squad.claude-code.connect');
    try {
      // Check claude CLI exists
      const { stdout } = await execFileAsync('claude', ['--version'], {
        cwd: this.options.cwd,
        timeout: 10_000,
      });
      this.cliVersion = stdout.trim();
      this.state = 'connected';
      span.setAttribute('claude_code.version', this.cliVersion);
    } catch (error) {
      this.state = 'error';
      const err = error instanceof Error ? error : new Error(String(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw new SDKConnectionError(
        `Claude Code CLI not found or not accessible: ${err.message}`,
        { timestamp: new Date(), operation: 'connect' },
        err,
      );
    } finally {
      span.end();
    }
  }

  /**
   * Close all active sessions and clean up.
   */
  async disconnect(): Promise<Error[]> {
    const errors: Error[] = [];
    for (const [id, session] of this.activeSessions) {
      try {
        await session.close();
        this.registry.update(id, { status: 'destroyed' });
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    this.activeSessions.clear();
    this.state = 'disconnected';
    return errors;
  }

  async forceDisconnect(): Promise<void> {
    for (const session of this.activeSessions.values()) {
      await session.abort();
    }
    this.activeSessions.clear();
    this.state = 'disconnected';
  }

  /**
   * Create a new Claude Code session.
   * Generates a fresh session ID and registers it.
   */
  async createSession(config: SquadSessionConfig = {}): Promise<SquadSession> {
    const span = tracer.startSpan('squad.claude-code.createSession');
    try {
      if (!this.isConnected()) {
        await this.connect();
      }

      const sessionId = config.sessionId ?? randomUUID();
      const model = config.model ?? this.options.defaultModel;

      const sessionOpts: ClaudeCodeSessionOptions = {
        sessionId,
        model,
        cwd: config.workingDirectory ?? this.options.cwd,
        permissionMode: this.options.defaultPermissionMode,
        mcpConfig: this.options.mcpConfig,
        timeoutMs: this.options.defaultTimeoutMs,
        isResume: false,
      };

      // Map system message config to CLI flags
      if (config.systemMessage) {
        if (config.systemMessage.mode === 'replace' && 'content' in config.systemMessage) {
          sessionOpts.systemPrompt = config.systemMessage.content;
        } else if ('content' in config.systemMessage && config.systemMessage.content) {
          sessionOpts.appendSystemPrompt = config.systemMessage.content;
        }
      }

      // If caller provides onPermissionRequest (approve-all pattern from Copilot SDK),
      // set permission mode to 'auto' so claude doesn't block on TTY prompts.
      // Non-interactive subprocess = must have a non-interactive permission mode.
      if (config.onPermissionRequest && !sessionOpts.permissionMode) {
        sessionOpts.permissionMode = 'auto';
      }

      // Fallback: if no permission mode is set at all, default to 'auto'
      // since we're running non-interactively (no stdin)
      if (!sessionOpts.permissionMode) {
        sessionOpts.permissionMode = 'auto';
      }

      // Map tool restrictions
      if (config.availableTools) {
        sessionOpts.allowedTools = config.availableTools;
      }
      if (config.excludedTools) {
        sessionOpts.disallowedTools = config.excludedTools;
      }

      const session = new ClaudeCodeSession(sessionOpts);
      this.activeSessions.set(sessionId, session);

      // Derive agent name: clientName > parsed from charter > model > default
      let agentName = config.clientName ?? config.model ?? 'default';
      if (agentName === 'default' || agentName === model) {
        // Try to extract agent name from system prompt charter header: "# Name — Role"
        const sysContent = config.systemMessage && 'content' in config.systemMessage
          ? config.systemMessage.content ?? ''
          : '';
        const charterMatch = sysContent.match(/^#\s+(\w+)\s+—/m);
        if (charterMatch?.[1]) {
          agentName = charterMatch[1].toLowerCase();
        }
      }
      this.registry.register(sessionId, agentName, model ?? 'sonnet');

      // Wire post-completion hooks for .squad/ artifacts
      this.wireSessionHooks(session, sessionId, agentName);

      span.setAttribute('session.id', sessionId);

      // Emit client event
      this.emitClientEvent({
        type: 'session.created',
        sessionId,
      });

      return session;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Resume an existing session by ID.
   */
  async resumeSession(sessionId: string, config: SquadSessionConfig = {}): Promise<SquadSession> {
    const span = tracer.startSpan('squad.claude-code.resumeSession');
    span.setAttribute('session.id', sessionId);
    try {
      if (!this.isConnected()) {
        await this.connect();
      }

      const model = config.model ?? this.options.defaultModel;

      const sessionOpts: ClaudeCodeSessionOptions = {
        sessionId,
        model,
        cwd: config.workingDirectory ?? this.options.cwd,
        permissionMode: this.options.defaultPermissionMode,
        mcpConfig: this.options.mcpConfig,
        timeoutMs: this.options.defaultTimeoutMs,
        isResume: true,
      };

      const session = new ClaudeCodeSession(sessionOpts);
      this.activeSessions.set(sessionId, session);
      this.registry.update(sessionId, { status: 'active' });

      return session;
    } finally {
      span.end();
    }
  }

  /**
   * List sessions from the local registry.
   */
  async listSessions(): Promise<SquadSessionMetadata[]> {
    return this.registry.list().map(r => ({
      sessionId: r.id,
      startTime: new Date(r.createdAt),
      modifiedTime: new Date(r.lastActivityAt),
      summary: `${r.agentName} (${r.model}) — ${r.status}`,
      isRemote: false,
    }));
  }

  /**
   * Delete a session — close it and remove from registry.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      await session.close();
      this.activeSessions.delete(sessionId);
    }
    this.registry.update(sessionId, { status: 'destroyed' });

    this.emitClientEvent({
      type: 'session.deleted',
      sessionId,
    });
  }

  async getLastSessionId(): Promise<string | undefined> {
    const sessions = this.registry.list()
      .filter(s => s.status !== 'destroyed')
      .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());
    return sessions[0]?.id;
  }

  async ping(): Promise<{ message: string; timestamp: number }> {
    return {
      message: `Claude Code ${this.cliVersion ?? 'unknown'}`,
      timestamp: Date.now(),
    };
  }

  async getStatus(): Promise<SquadGetStatusResponse> {
    return {
      version: this.cliVersion ?? 'unknown',
      protocolVersion: 1,
    };
  }

  async getAuthStatus(): Promise<SquadGetAuthStatusResponse> {
    try {
      // claude --version succeeds = authenticated (CLI handles auth internally)
      await execFileAsync('claude', ['--version'], { timeout: 10_000 });
      return {
        isAuthenticated: true,
        authType: 'user',
        statusMessage: 'Authenticated via Claude Code CLI',
      };
    } catch {
      return {
        isAuthenticated: false,
        statusMessage: 'Claude Code CLI not authenticated. Run: claude auth',
      };
    }
  }

  async listModels(): Promise<SquadModelInfo[]> {
    // CC uses aliases — return the known set
    return [
      { id: 'opus', name: 'Claude Opus', capabilities: { supports: { vision: true, reasoningEffort: true }, limits: { max_context_window_tokens: 200000 } } },
      { id: 'sonnet', name: 'Claude Sonnet', capabilities: { supports: { vision: true, reasoningEffort: true }, limits: { max_context_window_tokens: 200000 } } },
      { id: 'haiku', name: 'Claude Haiku', capabilities: { supports: { vision: true, reasoningEffort: false }, limits: { max_context_window_tokens: 200000 } } },
    ];
  }

  /**
   * Send a message with OTel tracing (mirrors SquadClient.sendMessage).
   */
  async sendMessage(session: SquadSession, options: SquadMessageOptions): Promise<void> {
    const span = tracer.startSpan('squad.claude-code.sendMessage');
    span.setAttribute('session.id', session.sessionId);
    span.setAttribute('prompt.length', options.prompt.length);
    try {
      await session.sendMessage(options);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      span.end();
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    return this.deleteSession(sessionId);
  }

  on(handler: SquadClientEventHandler): () => void;
  on<K extends SquadClientEventType>(eventType: K, handler: (event: SquadClientEvent & { type: K }) => void): () => void;
  on(
    eventTypeOrHandler: SquadClientEventType | SquadClientEventHandler,
    handler?: (event: SquadClientEvent) => void,
  ): () => void {
    // Simplified: store all handlers, filter on emit
    const h = typeof eventTypeOrHandler === 'function'
      ? eventTypeOrHandler
      : (event: SquadClientEvent) => {
          if (event.type === eventTypeOrHandler) handler?.(event);
        };
    this.clientEventHandlers.add(h);
    return () => this.clientEventHandlers.delete(h);
  }

  /**
   * Wire post-completion hooks onto a session.
   * Updates .squad/ artifacts when agents finish work:
   * - Session registry: cost, status, turn count
   * - Agent history: learnings appended after each interaction
   */
  private wireSessionHooks(session: ClaudeCodeSession, sessionId: string, agentName: string): void {
    const squadRoot = this.options.squadRoot ?? this.options.cwd;

    // Track usage for registry updates
    session.on('usage', (event: { type: string; [key: string]: unknown }) => {
      const cost = typeof event['totalCostUsd'] === 'number' ? event['totalCostUsd'] : undefined;
      const turns = typeof event['numTurns'] === 'number' ? event['numTurns'] : undefined;
      this.registry.update(sessionId, {
        status: 'active',
        ...(cost !== undefined && { totalCostUsd: cost }),
        ...(turns !== undefined && { totalTurns: turns }),
      });
    });

    // Append response summary to agent history on completion
    session.on('message', (event: { type: string; [key: string]: unknown }) => {
      const text = typeof event['text'] === 'string' ? event['text'] : '';
      if (!text || event['isError']) return;

      const summary = text.length > 300
        ? text.slice(0, 300).trimEnd() + '...'
        : text;

      // Fire and forget — don't block the session
      appendToHistory(squadRoot, agentName, 'Learnings', summary).catch(() => {
        // Silently ignore — history update is best-effort
      });
    });

    // Mark session idle on completion
    session.on('idle', () => {
      this.registry.update(sessionId, { status: 'idle' });
    });
  }

  private emitClientEvent(event: SquadClientEvent): void {
    for (const handler of this.clientEventHandlers) {
      try {
        handler(event);
      } catch {
        // Isolated — handler errors don't propagate
      }
    }
  }
}
