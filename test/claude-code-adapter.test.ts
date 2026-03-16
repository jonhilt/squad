/**
 * Tests for Claude Code adapter — event mapper, session, and client.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseCCStreamLine,
  mapCCEventToSquad,
  type CCAssistantEvent,
  type CCResultEvent,
  type CCSystemEvent,
  type CCRateLimitEvent,
} from '@bradygaster/squad-sdk/adapter/claude-code-event-mapper';

// ============================================================================
// Event Mapper Tests
// ============================================================================

describe('parseCCStreamLine', () => {
  it('should parse valid JSON lines', () => {
    const line = '{"type":"result","subtype":"success","result":"hello"}';
    const event = parseCCStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('result');
  });

  it('should return null for empty lines', () => {
    expect(parseCCStreamLine('')).toBeNull();
    expect(parseCCStreamLine('  ')).toBeNull();
  });

  it('should return null for non-JSON lines', () => {
    expect(parseCCStreamLine('some stderr output')).toBeNull();
    expect(parseCCStreamLine('Error: something went wrong')).toBeNull();
  });

  it('should handle lines with leading/trailing whitespace', () => {
    const line = '  {"type":"result","result":"hi"}  ';
    const event = parseCCStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('result');
  });
});

describe('mapCCEventToSquad — assistant events', () => {
  it('should map text content to message_delta', () => {
    const event: CCAssistantEvent = {
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-6',
        id: 'msg_123',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
        stop_reason: null,
      },
      session_id: 'sess-1',
    };

    const mapped = mapCCEventToSquad(event);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.type).toBe('message_delta');
    expect(mapped[0]!.text).toBe('Hello world');
    expect(mapped[0]!.deltaContent).toBe('Hello world');
    expect(mapped[0]!.model).toBe('claude-sonnet-4-6');
  });

  it('should map thinking content to reasoning_delta', () => {
    const event: CCAssistantEvent = {
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-6',
        id: 'msg_123',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Let me think...' }],
        stop_reason: null,
      },
      session_id: 'sess-1',
    };

    const mapped = mapCCEventToSquad(event);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.type).toBe('reasoning_delta');
    expect(mapped[0]!.text).toBe('Let me think...');
  });

  it('should map tool_use blocks', () => {
    const event: CCAssistantEvent = {
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-6',
        id: 'msg_123',
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tool_1',
          name: 'Bash',
          input: { command: 'ls' },
        }],
        stop_reason: null,
      },
      session_id: 'sess-1',
    };

    const mapped = mapCCEventToSquad(event);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.type).toBe('tool_use');
    expect(mapped[0]!.toolName).toBe('Bash');
  });

  it('should emit turn_end when stop_reason is set', () => {
    const event: CCAssistantEvent = {
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-6',
        id: 'msg_123',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        stop_reason: 'end_turn',
      },
      session_id: 'sess-1',
    };

    const mapped = mapCCEventToSquad(event);
    expect(mapped).toHaveLength(2);
    expect(mapped[0]!.type).toBe('message_delta');
    expect(mapped[1]!.type).toBe('turn_end');
    expect(mapped[1]!.stopReason).toBe('end_turn');
  });

  it('should handle multiple content blocks in one message', () => {
    const event: CCAssistantEvent = {
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-6',
        id: 'msg_123',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Hmm...' },
          { type: 'text', text: 'Here is my answer' },
        ],
        stop_reason: 'end_turn',
      },
      session_id: 'sess-1',
    };

    const mapped = mapCCEventToSquad(event);
    expect(mapped).toHaveLength(3); // reasoning + message + turn_end
    expect(mapped[0]!.type).toBe('reasoning_delta');
    expect(mapped[1]!.type).toBe('message_delta');
    expect(mapped[2]!.type).toBe('turn_end');
  });
});

describe('mapCCEventToSquad — result events', () => {
  it('should map result to message + usage + idle', () => {
    const event: CCResultEvent = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 2500,
      duration_api_ms: 2400,
      num_turns: 1,
      result: 'Hi there!',
      stop_reason: 'end_turn',
      session_id: 'sess-1',
      total_cost_usd: 0.05,
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 0,
      },
    };

    const mapped = mapCCEventToSquad(event);
    expect(mapped).toHaveLength(3);

    // message
    expect(mapped[0]!.type).toBe('message');
    expect(mapped[0]!.text).toBe('Hi there!');
    expect(mapped[0]!.isError).toBe(false);

    // usage
    expect(mapped[1]!.type).toBe('usage');
    expect(mapped[1]!.inputTokens).toBe(100);
    expect(mapped[1]!.outputTokens).toBe(10);
    expect(mapped[1]!.totalCostUsd).toBe(0.05);

    // idle
    expect(mapped[2]!.type).toBe('idle');
    expect(mapped[2]!.stopReason).toBe('end_turn');
  });

  it('should mark error results', () => {
    const event: CCResultEvent = {
      type: 'result',
      subtype: 'error',
      is_error: true,
      duration_ms: 100,
      duration_api_ms: 50,
      num_turns: 0,
      result: 'Something went wrong',
      stop_reason: 'error',
      session_id: 'sess-1',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    };

    const mapped = mapCCEventToSquad(event);
    const msg = mapped.find(e => e.type === 'message');
    expect(msg!.isError).toBe(true);
  });
});

describe('mapCCEventToSquad — system events', () => {
  it('should map init to session_init', () => {
    const event: CCSystemEvent = {
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      tools: ['Bash', 'Read', 'Edit'],
      model: 'claude-sonnet-4-6',
      cwd: '/home/user/project',
    };

    const mapped = mapCCEventToSquad(event);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.type).toBe('session_init');
    expect(mapped[0]!.tools).toEqual(['Bash', 'Read', 'Edit']);
  });

  it('should ignore hook events', () => {
    const event: CCSystemEvent = {
      type: 'system',
      subtype: 'hook_started',
      session_id: 'sess-1',
    };

    const mapped = mapCCEventToSquad(event);
    expect(mapped).toHaveLength(0);
  });
});

describe('mapCCEventToSquad — rate limit events', () => {
  it('should emit error for rate-limited events', () => {
    const event: CCRateLimitEvent = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'limited',
        resetsAt: 1700000000,
        rateLimitType: 'five_hour',
      },
      session_id: 'sess-1',
    };

    const mapped = mapCCEventToSquad(event);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.type).toBe('error');
    expect(mapped[0]!.errorType).toBe('rate_limit');
  });

  it('should ignore allowed rate limit events', () => {
    const event: CCRateLimitEvent = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: 1700000000,
        rateLimitType: 'five_hour',
      },
      session_id: 'sess-1',
    };

    const mapped = mapCCEventToSquad(event);
    expect(mapped).toHaveLength(0);
  });
});

describe('mapCCEventToSquad — unknown events', () => {
  it('should return empty array for unknown event types', () => {
    const event = { type: 'some_future_event', data: 'whatever' };
    const mapped = mapCCEventToSquad(event);
    expect(mapped).toHaveLength(0);
  });
});
