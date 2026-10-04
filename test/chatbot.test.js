import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatbot } from '../src/chatbot.js';

test('纯聊天保留多轮上下文，不发送工具，支持清空', async () => {
  let count = 0;
  const bot = createChatbot({ provider: { async complete(messages, tools) {
    assert.deepEqual(tools, []);
    assert.equal(messages.length, ++count === 1 ? 2 : 4);
    return { message: { role: 'assistant', content: 'hello' }, usage: {} };
  } } });
  assert.equal((await bot.chat('hi')).content, 'hello');
  await bot.chat('again'); assert.equal(bot.messages.length, 5);
  bot.reset(); assert.equal(bot.messages.length, 1);
});
test('失败或取消不污染历史，不执行模型意外返回的工具', async () => {
  const bot = createChatbot({ provider: { async complete() { throw new Error('network'); } } });
  await assert.rejects(bot.chat('hi'), /network/); assert.equal(bot.messages.length, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(bot.chat('hi', { signal: controller.signal })); assert.equal(bot.messages.length, 1);
  const invalid = createChatbot({ provider: { async complete() { return { message: { tool_calls: [{}] } }; } } });
  await assert.rejects(invalid.chat('hi'), /无效回答/);
});
