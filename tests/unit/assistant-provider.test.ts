import { afterEach, expect, it, vi } from 'vitest';
import { ProviderError, streamCompletion } from '../../server/src/modules/assistant/provider';

// The provider adapter is tested against recorded-shape streams, not a live service.
const stream = (chunks: string[]) => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }), { status: 200 });
const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const call = (tools: { name: string; description: string; parameters: Record<string, unknown> }[] = []) => {
  const text: string[] = [];
  return { text, result: streamCompletion({ messages: [{ role: 'user', content: 'hi' }], tools, signal: new AbortController().signal, onText: delta => text.push(delta) }) };
};
afterEach(() => vi.unstubAllGlobals());

it('streams text and reports usage, even when a frame is split across network chunks', async () => {
  const body = frame({ choices: [{ delta: { content: 'Hello ' } }] }) + frame({ choices: [{ delta: { content: 'there' }, finish_reason: 'stop' }] }) + frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }) + 'data: [DONE]\n\n';
  vi.stubGlobal('fetch', vi.fn(async () => stream([body.slice(0, 25), body.slice(25, 90), body.slice(90)])));
  const { text, result } = call();
  await expect(result).resolves.toMatchObject({ text: 'Hello there', toolCalls: [], finish: 'stop', usage: { input: 12, output: 3 } });
  expect(text.join('')).toBe('Hello there');
});

it('assembles tool calls sent in pieces and tool calls sent whole', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => stream([
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'my_records', arguments: '{"ki' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'nd":"orders"}' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ function: { name: 'search_products', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }),
  ])));
  const turn = await call().result;
  expect(turn.toolCalls.map(item => [item.function.name, JSON.parse(item.function.arguments)])).toEqual([['my_records', { kind: 'orders' }], ['search_products', {}]]);
  expect(turn.toolCalls.every(item => item.id)).toBe(true);
});

it('sends the key only in the Authorization header and omits schema keywords some providers reject', async () => {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => stream([frame({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })]));
  vi.stubGlobal('fetch', fetchMock);
  await call([{ name: 'my_records', description: 'd', parameters: { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'], additionalProperties: false } }]).result;
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toMatch(/\/chat\/completions$/);
  const body = JSON.parse(String(init.body));
  expect(body.tools[0].function.parameters).toEqual({ type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'] });
  expect(JSON.stringify(body)).not.toContain('Bearer');
  expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
});

it('reports provider failures by status without exposing the provider’s message', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"quota exceeded for project 123"}}', { status: 429 })));
  const failure = await call().result.catch(error => error);
  expect(failure).toBeInstanceOf(ProviderError);
  expect(failure.status).toBe(429);
  expect(failure.message).not.toContain('quota');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
  await expect(call().result).rejects.toMatchObject({ status: null, aborted: false });
});
