import { env } from '../../config/env.js';

// The assistant talks to any provider that accepts the OpenAI-style chat completions
// API with function calling and streaming: Google Gemini, Groq, OpenRouter and others.
// Which one is a matter of three settings (ASSISTANT_BASE_URL, ASSISTANT_API_KEY,
// ASSISTANT_MODEL); see docs/ASSISTANT.md. The key never leaves the server.
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export type ToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };

export class ProviderError extends Error {
  constructor(public status: number | null, public aborted = false) { super(aborted ? 'Assistant request stopped' : `Assistant provider responded ${status ?? 'with a connection failure'}`); }
}
export const assistantEnabled = () => Boolean(env.ASSISTANT_API_KEY);

// Some providers reject JSON Schema keywords they do not implement. Inputs are
// validated again on the server with strict schemas, so these are safe to omit.
function portable(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(portable);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'additionalProperties').map(([key, value]) => [key, portable(value)]));
}

/** One streamed model turn. Text is passed to `onText` as it arrives; tool calls are returned whole. */
export async function streamCompletion(input: { messages: ChatMessage[]; tools: ToolDefinition[]; signal: AbortSignal; onText: (delta: string) => void }) {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(45_000)]);
  let response: Response;
  try {
    response = await fetch(`${env.ASSISTANT_BASE_URL}/chat/completions`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.ASSISTANT_API_KEY}` },
      body: JSON.stringify({
        model: env.ASSISTANT_MODEL, stream: true, max_tokens: 2000, messages: input.messages,
        ...(input.tools.length ? { tools: input.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: portable(tool.parameters) } })) } : {}),
      }),
    });
  } catch { throw new ProviderError(null, input.signal.aborted); }
  if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw new ProviderError(response.status); }

  let text = '', finish = '', buffer = '';
  const calls: ToolCall[] = [];
  const usage = { input: null as number | null, output: null as number | null };
  const decoder = new TextDecoder();
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        const data = line.startsWith('data:') ? line.slice(5).trim() : '';
        if (!data || data === '[DONE]') continue;
        let event: any;
        try { event = JSON.parse(data); } catch { continue; }
        if (event.usage) { usage.input = event.usage.prompt_tokens ?? usage.input; usage.output = event.usage.completion_tokens ?? usage.output; }
        const choice = event.choices?.[0];
        if (!choice) continue;
        if (typeof choice.delta?.content === 'string' && choice.delta.content) { text += choice.delta.content; input.onText(choice.delta.content); }
        // Tool calls arrive in pieces keyed by index; some providers send each call whole.
        for (const part of choice.delta?.tool_calls ?? []) {
          const index = typeof part.index === 'number' ? part.index : calls.length;
          const call = calls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.function.name = part.function.name;
          if (typeof part.function?.arguments === 'string') call.function.arguments += part.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }
  } catch { throw new ProviderError(null, input.signal.aborted); }
  const toolCalls = calls.filter(Boolean).map((call, index) => ({ ...call, id: call.id || `call_${index}` }));
  return { text, toolCalls, finish, usage };
}
