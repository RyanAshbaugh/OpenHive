import type { StreamParser } from './adapter.js';

/**
 * Parse Claude Code `--output-format stream-json` JSONL.
 *
 * Claude stream-json emits one JSON object per line. Key event types:
 * - {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 * - {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
 * - {"type":"system","subtype":"init",...}
 * - {"type":"result",...}
 *
 * We extract text from assistant messages and deltas.
 */
export const claudeStreamParser: StreamParser = (line: string): string | null => {
  try {
    const event = JSON.parse(line);

    // Assistant message with content blocks
    if (event.type === 'assistant' && event.message?.content) {
      const texts: string[] = [];
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          texts.push(block.text);
        } else if (block.type === 'tool_use') {
          texts.push(`[tool: ${block.name}]\n`);
        }
      }
      if (texts.length > 0) return texts.join('') + '\n';
    }

    // Incremental text delta
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      return event.delta.text ?? null;
    }

    // Result summary
    if (event.type === 'result') {
      const cost = event.cost_usd ? ` ($${event.cost_usd.toFixed(4)})` : '';
      const dur = event.duration_ms ? ` ${(event.duration_ms / 1000).toFixed(1)}s` : '';
      return `\n[result: ${event.subtype ?? 'done'}${dur}${cost}]\n`;
    }

    // Skip system/init/other events silently
    return null;
  } catch {
    // Not valid JSON — return the raw line
    return line + '\n';
  }
};

/**
 * Parse Codex CLI `codex exec --json` JSONL events.
 *
 * Codex exec --json emits JSONL events. Key types:
 * - {"type":"message","role":"assistant","content":[{"type":"output_text","text":"..."}]}
 * - {"type":"function_call","name":"...","arguments":"..."}
 * - {"type":"function_call_output","output":"..."}
 * - Other event types for status, errors, etc.
 */
export const codexStreamParser: StreamParser = (line: string): string | null => {
  try {
    const event = JSON.parse(line);

    // Assistant message text
    if (event.type === 'message' && event.role === 'assistant' && event.content) {
      const texts: string[] = [];
      for (const block of event.content) {
        if (block.type === 'output_text' && block.text) {
          texts.push(block.text);
        } else if (block.type === 'text' && block.text) {
          texts.push(block.text);
        }
      }
      if (texts.length > 0) return texts.join('') + '\n';
    }

    // Function call
    if (event.type === 'function_call' && event.name) {
      return `[tool: ${event.name}]\n`;
    }

    // Function output
    if (event.type === 'function_call_output' && event.output) {
      const out = event.output.length > 200 ? event.output.slice(0, 200) + '...' : event.output;
      return `${out}\n`;
    }

    return null;
  } catch {
    return line + '\n';
  }
};

/**
 * Parse Gemini CLI `--output-format stream-json` JSONL.
 *
 * Gemini stream-json emits JSON objects per line. Key types:
 * - {"type":"text","content":"..."}
 * - {"type":"functionCall","name":"...","args":{...}}
 * - {"type":"functionResponse","name":"...","response":{...}}
 * - {"type":"result",...}
 */
export const geminiStreamParser: StreamParser = (line: string): string | null => {
  try {
    const event = JSON.parse(line);

    // Direct text content
    if (event.type === 'text' && event.content) {
      return event.content;
    }

    // Partial text (some versions use this)
    if (event.type === 'partialText' && event.text) {
      return event.text;
    }

    // Assistant message with parts
    if (event.message?.parts) {
      const texts: string[] = [];
      for (const part of event.message.parts) {
        if (part.text) texts.push(part.text);
        if (part.functionCall) texts.push(`[tool: ${part.functionCall.name}]\n`);
      }
      if (texts.length > 0) return texts.join('') + '\n';
    }

    // Function call
    if (event.type === 'functionCall' && event.name) {
      return `[tool: ${event.name}]\n`;
    }

    return null;
  } catch {
    return line + '\n';
  }
};
