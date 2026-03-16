/**
 * Claude Code Session
 *
 * Implements SquadSession by spawning short-lived `claude -p` subprocesses.
 * Each sendMessage() call spawns a new process with `--resume` to continue
 * the conversation. The NDJSON stream is parsed in real-time and emitted
 * as Squad session events.
 *
 * @module adapter/claude-code-session
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type {
  SquadSession,
  SquadSessionEvent,
  SquadSessionEventType,
  SquadSessionEventHandler,
  SquadMessageOptions,
} from './types.js';
import {
  parseCCStreamLine,
  mapCCEventToSquad,
  type CCResultEvent,
} from './claude-code-event-mapper.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface ClaudeCodeSessionOptions {
  /** Session ID (UUID) */
  sessionId: string;
  /** Model alias (sonnet, opus, haiku) */
  model?: string;
  /** System prompt to inject */
  systemPrompt?: string;
  /** Append to default system prompt instead of replacing */
  appendSystemPrompt?: string;
  /** Working directory for the claude process */
  cwd?: string;
  /** Permission mode */
  permissionMode?: 'acceptEdits' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan' | 'auto';
  /** Allowed tools */
  allowedTools?: string[];
  /** Disallowed tools */
  disallowedTools?: string[];
  /** MCP config file path */
  mcpConfig?: string;
  /** Timeout in ms (default: 10 min) */
  timeoutMs?: number;
  /** Whether this is a resumed session (use --resume instead of --session-id) */
  isResume?: boolean;
}

export class ClaudeCodeSession implements SquadSession {
  readonly sessionId: string;

  private readonly options: ClaudeCodeSessionOptions;
  private readonly emitter = new EventEmitter();
  private activeProcess: ChildProcess | null = null;
  private timeoutMs: number;

  constructor(options: ClaudeCodeSessionOptions) {
    this.sessionId = options.sessionId;
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Build the CLI arguments for spawning a claude process.
   */
  private buildArgs(prompt: string): string[] {
    const args: string[] = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
    ];

    // Session identity
    if (this.options.isResume) {
      args.push('--resume', this.sessionId);
    } else {
      args.push('--session-id', this.sessionId);
    }

    // Model
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // System prompt
    if (this.options.systemPrompt) {
      args.push('--system-prompt', this.options.systemPrompt);
    }
    if (this.options.appendSystemPrompt) {
      args.push('--append-system-prompt', this.options.appendSystemPrompt);
    }

    // Permission mode
    if (this.options.permissionMode) {
      args.push('--permission-mode', this.options.permissionMode);
    }

    // Tool control
    if (this.options.allowedTools && this.options.allowedTools.length > 0) {
      args.push('--allowedTools', ...this.options.allowedTools);
    }
    if (this.options.disallowedTools && this.options.disallowedTools.length > 0) {
      args.push('--disallowedTools', ...this.options.disallowedTools);
    }

    // MCP
    if (this.options.mcpConfig) {
      args.push('--mcp-config', this.options.mcpConfig);
    }

    // Prompt as positional argument
    args.push(prompt);

    return args;
  }

  /**
   * Spawn a claude process, stream NDJSON, and emit Squad events.
   * Resolves when the process exits.
   */
  private spawnAndStream(prompt: string): Promise<CCResultEvent | null> {
    return new Promise((resolve, reject) => {
      const args = this.buildArgs(prompt);
      const proc = spawn('claude', args, {
        cwd: this.options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      this.activeProcess = proc;
      let resultEvent: CCResultEvent | null = null;

      // Timeout
      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Claude Code session timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      // Parse stdout as NDJSON
      const rl = createInterface({ input: proc.stdout! });
      rl.on('line', (line) => {
        const ccEvent = parseCCStreamLine(line);
        if (!ccEvent) return;

        // Capture the result event for sendAndWait
        if (ccEvent.type === 'result') {
          resultEvent = ccEvent as CCResultEvent;
        }

        // Map to Squad events and emit
        const squadEvents = mapCCEventToSquad(ccEvent);
        for (const se of squadEvents) {
          this.emitter.emit(se.type, se);
        }
      });

      // Collect stderr for error reporting
      let stderr = '';
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this.activeProcess = null;

        if (code !== 0 && !resultEvent) {
          const msg = stderr.trim() || `claude process exited with code ${code}`;
          this.emitter.emit('error', { type: 'error', errorType: 'process_exit', message: msg, code });
          reject(new Error(msg));
        } else {
          resolve(resultEvent);
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        this.activeProcess = null;
        reject(err);
      });

      // Close stdin — prompt is passed as CLI arg, not piped
      proc.stdin?.end();
    });
  }

  async sendMessage(options: SquadMessageOptions): Promise<void> {
    await this.spawnAndStream(options.prompt);
    // After first successful message, subsequent messages resume the session
    this.options.isResume = true;
  }

  async sendAndWait(options: SquadMessageOptions, timeout?: number): Promise<unknown> {
    const originalTimeout = this.timeoutMs;
    if (timeout) {
      this.timeoutMs = timeout;
    }

    try {
      const result = await this.spawnAndStream(options.prompt);
      // After first successful message, subsequent messages resume the session
      this.options.isResume = true;
      return result?.result ?? null;
    } finally {
      this.timeoutMs = originalTimeout;
    }
  }

  async abort(): Promise<void> {
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }
  }

  async getMessages(): Promise<unknown[]> {
    // Not implemented in Phase 1 — CC persists messages internally
    return [];
  }

  on(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void {
    this.emitter.on(eventType, handler);
  }

  off(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void {
    this.emitter.off(eventType, handler);
  }

  async close(): Promise<void> {
    await this.abort();
    this.emitter.removeAllListeners();
  }
}
