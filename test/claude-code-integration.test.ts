/**
 * Integration test for Claude Code adapter.
 *
 * Actually spawns `claude -p` and verifies the adapter works end-to-end.
 * Requires: claude CLI installed and authenticated.
 *
 * Run with: npx vitest run test/claude-code-integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClaudeCodeClient } from '@bradygaster/squad-sdk/adapter/claude-code-client';

const execFileAsync = promisify(execFile);

// Skip if claude CLI not available
let hasClaude = false;
try {
  await execFileAsync('claude', ['--version'], { timeout: 10_000 });
  hasClaude = true;
} catch {
  // not installed
}

const describeIfClaude = hasClaude ? describe : describe.skip;

describeIfClaude('ClaudeCodeClient — live integration', () => {
  let client: ClaudeCodeClient;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-cc-test-'));
    fs.mkdirSync(path.join(tmpDir, '.squad'), { recursive: true });

    client = new ClaudeCodeClient({
      squadRoot: tmpDir,
      cwd: tmpDir,
      defaultModel: 'haiku',
      defaultPermissionMode: 'bypassPermissions',
      defaultTimeoutMs: 30_000,
    });
  });

  afterAll(async () => {
    await client.disconnect();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should connect (verify claude CLI exists)', async () => {
    await client.connect();
    expect(client.isConnected()).toBe(true);
    expect(client.getState()).toBe('connected');
  });

  it('should report auth status', async () => {
    const auth = await client.getAuthStatus();
    expect(auth.isAuthenticated).toBe(true);
  });

  it('should list known models', async () => {
    const models = await client.listModels();
    expect(models.length).toBeGreaterThan(0);
    const names = models.map(m => m.id);
    expect(names).toContain('sonnet');
    expect(names).toContain('haiku');
  });

  it('should create a session and send a message', async () => {
    const session = await client.createSession({
      model: 'haiku',
      systemMessage: { mode: 'replace', content: 'You are a test bot. Reply with exactly one word.' },
    });

    expect(session.sessionId).toBeTruthy();

    // Collect events
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    session.on('message_delta', (e) => events.push(e));
    session.on('message', (e) => events.push(e));
    session.on('usage', (e) => events.push(e));
    session.on('idle', (e) => events.push(e));

    const result = await session.sendAndWait({ prompt: 'Say "pong"' }, 30_000);

    // Should have received a result in Squad shell format
    expect(result).toBeTruthy();
    const resultObj = result as { data: { content: string } };
    expect(resultObj.data.content).toBeTruthy();
    expect(typeof resultObj.data.content).toBe('string');

    // Should have emitted Squad events
    const hasUsage = events.some(e => e.type === 'usage');
    const hasIdle = events.some(e => e.type === 'idle');
    expect(hasUsage).toBe(true);
    expect(hasIdle).toBe(true);

    // Session should be in the registry
    const sessions = await client.listSessions();
    expect(sessions.some(s => s.sessionId === session.sessionId)).toBe(true);

    await session.close();
  }, 60_000);

  it('should clean up on disconnect', async () => {
    const errors = await client.disconnect();
    expect(errors).toHaveLength(0);
    expect(client.isConnected()).toBe(false);
  });
});
