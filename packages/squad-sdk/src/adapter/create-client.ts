/**
 * Client Factory — Backend Selection
 *
 * Creates the appropriate Squad client based on the `backend` field
 * in .squad/config.json. Defaults to Copilot for backward compatibility.
 *
 * @module adapter/create-client
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SquadClient, type SquadClientOptions } from './client.js';
import { ClaudeCodeClient, type ClaudeCodeClientOptions } from './claude-code-client.js';

export type SquadBackend = 'copilot' | 'claude-code';

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
 * Usage:
 * ```typescript
 * const client = createSquadClient({ cwd: teamRoot });
 * await client.connect();
 * const session = await client.createSession({ model: 'sonnet' });
 * ```
 */
export function createSquadClient(options: CreateClientOptions): SquadClient | ClaudeCodeClient {
  const backend = options.backend ?? detectBackend(options.cwd);

  if (backend === 'claude-code') {
    return new ClaudeCodeClient({
      cwd: options.cwd,
      squadRoot: options.cwd,
      ...options.claudeCodeOptions,
    });
  }

  return new SquadClient({
    cwd: options.cwd,
    ...options.copilotOptions,
  });
}
