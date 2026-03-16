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

  it('should support multi-turn conversations via --resume', async () => {
    const session = await client.createSession({
      model: 'haiku',
      systemMessage: { mode: 'replace', content: 'You are a test bot. Always reply with exactly one word.' },
    });

    // Turn 1: establish context
    const r1 = await session.sendAndWait({ prompt: 'Remember the secret word: BANANA. Reply with OK.' }, 30_000);
    const t1 = (r1 as { data: { content: string } }).data.content;
    expect(t1).toBeTruthy();

    // Turn 2: recall context (proves --resume worked)
    const r2 = await session.sendAndWait({ prompt: 'What was the secret word? Reply with just the word.' }, 30_000);
    const t2 = (r2 as { data: { content: string } }).data.content.toLowerCase();
    expect(t2).toContain('banana');

    // Turn 3: further context retention
    const r3 = await session.sendAndWait({ prompt: 'Say the secret word backwards. Just the word.' }, 30_000);
    const t3 = (r3 as { data: { content: string } }).data.content.toLowerCase();
    expect(t3).toContain('ananab');

    await session.close();
  }, 120_000);

  it('should run parallel agents with different system prompts', async () => {
    // Agent 1: always responds in uppercase
    const session1 = await client.createSession({
      model: 'haiku',
      systemMessage: { mode: 'replace', content: 'You are SHOUTER bot. Always respond in ALL CAPS. One sentence max.' },
    });

    // Agent 2: always responds in lowercase
    const session2 = await client.createSession({
      model: 'haiku',
      systemMessage: { mode: 'replace', content: 'You are whisper bot. Always respond in all lowercase. One sentence max.' },
    });

    // Send to both in parallel
    const [r1, r2] = await Promise.all([
      session1.sendAndWait({ prompt: 'Say hello' }, 30_000),
      session2.sendAndWait({ prompt: 'Say hello' }, 30_000),
    ]);

    const t1 = (r1 as { data: { content: string } }).data.content;
    const t2 = (r2 as { data: { content: string } }).data.content;

    // Agent 1 should be mostly uppercase
    const uppercaseRatio1 = (t1.match(/[A-Z]/g) || []).length / Math.max(t1.replace(/[^a-zA-Z]/g, '').length, 1);
    expect(uppercaseRatio1).toBeGreaterThan(0.5);

    // Agent 2 should be mostly lowercase
    const lowercaseRatio2 = (t2.match(/[a-z]/g) || []).length / Math.max(t2.replace(/[^a-zA-Z]/g, '').length, 1);
    expect(lowercaseRatio2).toBeGreaterThan(0.5);

    await session1.close();
    await session2.close();
  }, 60_000);

  it('should pass charter content as system prompt', async () => {
    // Simulates what dispatchToAgent does: charter → buildAgentPrompt → systemMessage
    // Uses 'replace' mode since that's what gives full control (append competes with CC defaults)
    const charter = `# Pirate Bot — Translator

## Identity
You are a pirate translator. You MUST rewrite any input as a pirate would say it.
Always include "ARRR" in your response.

## Boundaries
- Never break character`;

    const systemPrompt = `You are an AI agent on a software development team.\n\nYOUR CHARTER:\n${charter}`;

    const session = await client.createSession({
      model: 'haiku',
      systemMessage: { mode: 'replace', content: systemPrompt },
    });

    const result = await session.sendAndWait({ prompt: 'Hello, how are you today?' }, 30_000);
    const text = (result as { data: { content: string } }).data.content.toUpperCase();
    expect(text).toContain('ARRR');

    await session.close();
  }, 60_000);

  it('should clean up on disconnect', async () => {
    const errors = await client.disconnect();
    expect(errors).toHaveLength(0);
    expect(client.isConnected()).toBe(false);
  });
});
