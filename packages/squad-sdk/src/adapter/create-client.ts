/**
 * Client Factory — Backend Selection
 *
 * Creates the appropriate Squad client based on the `backend` field
 * in .squad/config.json. Defaults to Copilot for backward compatibility.
 *
 * IMPORTANT: The Copilot SDK import is lazy (dynamic import) so that
 * claude-code backend users don't need @github/copilot-sdk installed.
 *
 * @module adapter/create-client
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClaudeCodeClient, type ClaudeCodeClientOptions } from './claude-code-client.js';
import type { SquadSession, SquadSessionConfig } from './types.js';

// SquadClient types imported for the return type — actual class loaded lazily
import type { SquadClientOptions } from './client.js';

export type SquadBackend = 'copilot' | 'claude-code';

/** Common interface satisfied by both SquadClient and ClaudeCodeClient */
export interface SquadClientLike {
  connect(): Promise<void>;
  disconnect(): Promise<Error[]>;
  createSession(config?: SquadSessionConfig): Promise<SquadSession>;
  isConnected(): boolean;
}

export interface CreateClientOptions {
  /** Working directory / team root */
  cwd: string;
  /** Explicit backend override (skips config.json lookup) */
  backend?: SquadBackend;
  /** Copilot-specific options (ignored for claude-code backend) */
  copilotOptions?: Omit<SquadClientOptions, 'cwd'>;
  /** Claude Code-specific options (ignored for copilot backend) */
  claudeCodeOptions?: Omit<ClaudeCodeClientOptions, 'cwd' | 'squadRoot'>;
}

/**
 * Read the `backend` field from .squad/config.json.
 * Returns 'copilot' if not found or not set.
 */
function detectBackend(cwd: string): SquadBackend {
  const configPath = path.join(cwd, '.squad', 'config.json');
  if (!fs.existsSync(configPath)) return 'copilot';

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.backend === 'claude-code') return 'claude-code';
  } catch {
    // Corrupt or unreadable config — fall back to default
  }

  return 'copilot';
}

/**
 * Create a Squad client for the detected or specified backend.
 *
 * The Copilot SDK is loaded lazily — only when backend is 'copilot'.
 * This means claude-code users don't need @github/copilot-sdk installed.
 *
 * Usage:
 * ```typescript
 * const client = await createSquadClient({ cwd: teamRoot });
 * await client.connect();
 * const session = await client.createSession({ model: 'sonnet' });
 * ```
 */
export async function createSquadClient(options: CreateClientOptions): Promise<SquadClientLike> {
  const backend = options.backend ?? detectBackend(options.cwd);

  if (backend === 'claude-code') {
    return new ClaudeCodeClient({
      cwd: options.cwd,
      squadRoot: options.cwd,
      ...options.claudeCodeOptions,
    });
  }

  // Lazy import — avoids loading @github/copilot-sdk when using claude-code
  const { SquadClient } = await import('./client.js');
  return new SquadClient({
    cwd: options.cwd,
    ...options.copilotOptions,
  });
}
