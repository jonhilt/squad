/**
 * Claude Code Session Registry
 *
 * Tracks Squad sessions in .squad/sessions/ as JSON files.
 * CC doesn't expose a listSessions() CLI command, so Squad
 * maintains its own registry for session awareness.
 *
 * @module adapter/claude-code-session-registry
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SessionRecord {
  id: string;
  agentName: string;
  model: string;
  status: 'creating' | 'active' | 'idle' | 'error' | 'destroyed';
  createdAt: string;
  lastActivityAt: string;
  totalCostUsd?: number;
  totalTurns?: number;
}

export class ClaudeCodeSessionRegistry {
  private readonly sessionsDir: string;

  constructor(squadRoot: string) {
    this.sessionsDir = path.join(squadRoot, '.squad', 'sessions');
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  private filePath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  register(sessionId: string, agentName: string, model: string): SessionRecord {
    this.ensureDir();
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: sessionId,
      agentName,
      model,
      status: 'creating',
      createdAt: now,
      lastActivityAt: now,
    };
    fs.writeFileSync(this.filePath(sessionId), JSON.stringify(record, null, 2));
    return record;
  }

  update(sessionId: string, updates: Partial<Pick<SessionRecord, 'status' | 'totalCostUsd' | 'totalTurns'>>): void {
    const record = this.get(sessionId);
    if (!record) return;

    const updated: SessionRecord = {
      ...record,
      ...updates,
      lastActivityAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.filePath(sessionId), JSON.stringify(updated, null, 2));
  }

  get(sessionId: string): SessionRecord | null {
    const fp = this.filePath(sessionId);
    if (!fs.existsSync(fp)) return null;
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf-8')) as SessionRecord;
    } catch {
      return null;
    }
  }

  list(): SessionRecord[] {
    this.ensureDir();
    const files = fs.readdirSync(this.sessionsDir).filter(f => f.endsWith('.json'));
    const records: SessionRecord[] = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(this.sessionsDir, file), 'utf-8');
        records.push(JSON.parse(content) as SessionRecord);
      } catch {
        // Skip corrupt files
      }
    }
    return records;
  }

  remove(sessionId: string): void {
    const fp = this.filePath(sessionId);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
    }
  }
}
