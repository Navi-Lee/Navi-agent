import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekProvider } from '../src/provider.js';
const success = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'ok', reasoning_content: 'hidden' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } });
test('请求格式，禁用思考，不暴露推理', async () => {
  const provider = createDeepSeekProvider({ apiKey: 'test', fetchImpl: async (url, options) => { assert.equal(url, 'https://api.deepseek.com/chat/completions'); assert.equal(JSON.parse(options.body).thinking.type, 'disabled'); return success(); } });
  const result = await provider.complete([], []); assert.equal(result.message.content, 'ok'); assert.equal(result.message.reasoning_content, undefined);
});
test('网络故障、429 和 5xx 有限重试', async () => {
  for (const status of [0, 429, 503]) { let attempts = 0; const provider = createDeepSeekProvider({ apiKey: 'test', retryDelayMs: 1, fetchImpl: async () => { if (++attempts === 1) { if (!status) throw new TypeError('network'); return new Response('', { status }); } return success(); } }); assert.equal((await provider.complete([], [])).message.content, 'ok'); assert.equal(attempts, 2); }
});
test('401 不重试，服务错误达到重试上限', async () => {
  for (const status of [401, 500]) { let count = 0; const provider = createDeepSeekProvider({ apiKey: 'test', retries: 2, retryDelayMs: 1, fetchImpl: async () => { count++; return new Response('', { status }); } }); await assert.rejects(provider.complete([], []), new RegExp(String(status))); assert.equal(count, status === 401 ? 1 : 3); }
});
test('请求超时和用户取消', async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(createDeepSeekProvider({ apiKey: 'test', timeoutMs: 20, retries: 0, fetchImpl }).complete([], []), /timeout/i); const controller = new AbortController(); controller.abort(); await assert.rejects(createDeepSeekProvider({ apiKey: 'test', fetchImpl }).complete([], [], { signal: controller.signal })); } finally { clearInterval(keepAlive); }
});
