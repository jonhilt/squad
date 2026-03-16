/**
 * Claude Code Event Mapper
 *
 * Maps Claude Code CLI stream-json NDJSON events to Squad session events.
 * CC emits structured JSON lines on stdout when invoked with:
 *   claude -p --output-format stream-json --verbose
 *
 * @module adapter/claude-code-event-mapper
 */

// ============================================================================
// CC Stream Event Types (input — what claude CLI emits)
// ============================================================================

/** Content block within an assistant message */
export interface CCContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/** Assistant message event from CC stream-json */
export interface CCAssistantEvent {
  type: 'assistant';
  message: {
    model: string;
    id: string;
    role: 'assistant';
    content: CCContentBlock[];
    stop_reason: string | null;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  session_id: string;
}

/** System event (init, hook responses, etc.) */
export interface CCSystemEvent {
  type: 'system';
  subtype: 'init' | 'hook_started' | 'hook_response' | string;
  session_id: string;
  tools?: string[];
  model?: string;
  cwd?: string;
  [key: string]: unknown;
}

/** Final result event — emitted when the session completes */
export interface CCResultEvent {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  stop_reason: string;
  session_id: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Rate limit event */
export interface CCRateLimitEvent {
  type: 'rate_limit_event';
  rate_limit_info: {
    status: 'allowed' | 'limited';
    resetsAt: number;
    rateLimitType: string;
  };
  session_id: string;
}

/** Union of all CC stream events */
export type CCStreamEvent =
  | CCAssistantEvent
  | CCSystemEvent
  | CCResultEvent
  | CCRateLimitEvent
  | { type: string; [key: string]: unknown };

// ============================================================================
// Squad Event Types (output — what Squad expects)
// ============================================================================

export interface SquadMappedEvent {
  type: string;
  [key: string]: unknown;
}

// ============================================================================
// Mapper
// ============================================================================

/**
 * Parse a single NDJSON line from CC stream-json output.
 * Returns null for unparseable lines (stderr leakage, empty lines, etc.)
 */
export function parseCCStreamLine(line: string): CCStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as CCStreamEvent;
  } catch {
    return null;
  }
}

/**
 * Map a CC stream event to zero or more Squad session events.
 *
 * Returns an array because some CC events map to multiple Squad events
 * (e.g., a result event emits both `usage` and `idle`).
 */
export function mapCCEventToSquad(event: CCStreamEvent): SquadMappedEvent[] {
  switch (event.type) {
    case 'assistant':
      return mapAssistantEvent(event as CCAssistantEvent);
    case 'system':
      return mapSystemEvent(event as CCSystemEvent);
    case 'result':
      return mapResultEvent(event as CCResultEvent);
    case 'rate_limit_event':
      return mapRateLimitEvent(event as CCRateLimitEvent);
    default:
      return [];
  }
}

function mapAssistantEvent(event: CCAssistantEvent): SquadMappedEvent[] {
  const events: SquadMappedEvent[] = [];
  const msg = event.message;

  for (const block of msg.content) {
    if (block.type === 'text' && block.text) {
      events.push({
        type: 'message_delta',
        text: block.text,
        // Squad shell extractDelta() looks for these field names
        deltaContent: block.text,
        delta: block.text,
        content: block.text,
        model: msg.model,
        messageId: msg.id,
      });
    }

    if (block.type === 'thinking' && block.thinking) {
      events.push({
        type: 'reasoning_delta',
        text: block.thinking,
        model: msg.model,
        messageId: msg.id,
      });
    }

    if (block.type === 'tool_use') {
      events.push({
        type: 'tool_use',
        toolName: block.name,
        toolCallId: block.id,
        arguments: block.input,
        model: msg.model,
      });
    }

    if (block.type === 'tool_result') {
      events.push({
        type: 'tool_result',
        toolCallId: block.id,
        result: block.text,
      });
    }
  }

  if (msg.stop_reason) {
    events.push({
      type: 'turn_end',
      stopReason: msg.stop_reason,
      model: msg.model,
    });
  }

  return events;
}

function mapSystemEvent(event: CCSystemEvent): SquadMappedEvent[] {
  if (event.subtype === 'init') {
    return [{
      type: 'session_init',
      tools: event.tools,
      model: event.model,
      cwd: event.cwd,
      sessionId: event.session_id,
    }];
  }
  // Hook events are internal to CC — don't propagate
  return [];
}

function mapResultEvent(event: CCResultEvent): SquadMappedEvent[] {
  const events: SquadMappedEvent[] = [];

  // Final message content
  if (event.result) {
    events.push({
      type: 'message',
      text: event.result,
      isError: event.is_error,
    });
  }

  // Usage data
  events.push({
    type: 'usage',
    inputTokens: event.usage.input_tokens,
    outputTokens: event.usage.output_tokens,
    cacheCreationInputTokens: event.usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: event.usage.cache_read_input_tokens ?? 0,
    totalCostUsd: event.total_cost_usd,
    durationMs: event.duration_ms,
    durationApiMs: event.duration_api_ms,
    numTurns: event.num_turns,
  });

  // Session idle (done processing)
  events.push({
    type: 'idle',
    stopReason: event.stop_reason,
    subtype: event.subtype,
  });

  return events;
}

function mapRateLimitEvent(event: CCRateLimitEvent): SquadMappedEvent[] {
  const info = event.rate_limit_info;
  if (info.status === 'limited') {
    return [{
      type: 'error',
      errorType: 'rate_limit',
      resetsAt: info.resetsAt,
      rateLimitType: info.rateLimitType,
    }];
  }
  return [];
}
