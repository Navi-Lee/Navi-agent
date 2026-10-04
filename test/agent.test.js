import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from '../src/agent.js';

const call = (id, name = 'echo', args = '{"value":"hi"}') => ({ id, type: 'function', function: { name, arguments: args } });
const tool = { name: 'echo', description: 'echo', parameters: {}, validate(a) { if (typeof a.value !== 'string') throw new Error('参数无效'); }, execute: async a => a.value };
const mock = replies => ({ async complete() { return { message: { role: 'assistant', ...replies.shift() }, usage: { total_tokens: 2 } }; } });

test('普通回答和累计用量', async () => {
  const agent = createAgent({ provider: mock([{ content: '你好' }]) });
  assert.equal((await agent.run('hi')).content, '你好');
  assert.equal(agent.messages.length, 3);
});
test('多工具按顺序执行并回传，多次模型循环', async () => {
  let step = 0;
  const provider = { async complete(messages) {
    if (step++ === 0) return { message: { role: 'assistant', content: null, tool_calls: [call('a'), call('b')] } };
    assert.deepEqual(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), step === 2 ? ['a', 'b'] : ['a', 'b', 'c']);
    return { message: step === 2 ? { role: 'assistant', content: null, tool_calls: [call('c')] } : { role: 'assistant', content: 'done' } };
  } };
  assert.equal((await createAgent({ provider, tools: [tool] }).run('run')).content, 'done');
});
test('未知工具、非法 JSON、非法参数、执行错误和拒绝授权返回失败结果', async () => {
  const failing = { ...tool, name: 'fail', execute() { throw new Error('执行失败'); } };
  const gated = { ...tool, name: 'gated', preview: async () => 'change' };
  const agent = createAgent({ tools: [tool, failing, gated], provider: mock([{ tool_calls: [call('a', 'unknown'), call('b', 'echo', 'bad'), call('c', 'echo', '{}'), call('d', 'fail'), call('e', 'gated')] }, { content: 'done' }]) });
  await agent.run('go');
  const results = agent.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  assert.equal(results.length, 5); assert.ok(results.every(r => !r.ok)); assert.equal(results[4].error, '用户拒绝授权');
});
test('达到上限会保存完整链', async () => {
  let saved;
  const agent = createAgent({ provider: mock([{ tool_calls: [call('a')] }]), tools: [tool], maxSteps: 1, save: async m => { saved = structuredClone(m); } });
  await assert.rejects(agent.run('go'), /上限/); assert.equal(saved.at(-1).role, 'tool');
});
test('取消后补齐所有 tool response 并保存', async () => {
  const controller = new AbortController(); let saved;
  const agent = createAgent({ provider: mock([{ tool_calls: [call('a'), call('b')] }]), tools: [{ ...tool, execute() { controller.abort(); return 'first'; } }], save: async m => { saved = structuredClone(m); } });
  await assert.rejects(agent.run('go', { signal: controller.signal }));
  assert.deepEqual(saved.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['a', 'b']);
  assert.equal(JSON.parse(saved.at(-1).content).error, '用户取消任务');
});
test('裁剪完整旧轮次，保留 system 和当前轮次', async () => {
  const messages = [{ role: 'system', content: 'system' }, { role: 'user', content: 'x'.repeat(200) }, { role: 'assistant', tool_calls: [call('old')] }, { role: 'tool', tool_call_id: 'old', content: 'ok' }, { role: 'assistant', content: 'done' }];
  const agent = createAgent({ provider: mock([{ content: 'ok' }]), messages, maxContextChars: 150 });
  await agent.run('new'); assert.deepEqual(messages.map(m => m.role), ['system', 'user', 'assistant']); assert.equal(messages[1].content, 'new');
});
test('输出截断仍是有效 JSON，当前轮过大会停止', async () => {
  const agent = createAgent({ provider: mock([{ tool_calls: [call('a')] }, { content: 'ok' }]), tools: [{ ...tool, execute: () => 'x'.repeat(1000) }], maxToolOutput: 200 });
  await agent.run('go'); const result = JSON.parse(agent.messages[3].content); assert.equal(result.truncated, true);
  await assert.rejects(createAgent({ provider: mock([]), maxContextChars: 10 }).run('too large'), /上下文过长/);
});

test('恢复旧会话也带当前检索提示，临时提示不改写保存的 system', async () => {
  const originalSystem = '旧版本的任务助手提示';
  const messages = [{ role: 'system', content: originalSystem }, { role: 'user', content: '旧任务' }, { role: 'assistant', content: '旧回答' }];
  let saved;
  const provider = { async complete(context, definitions) {
    assert.match(context[0].content, /先使用 knowledge_search/);
    assert.match(context[0].content, new RegExp(originalSystem));
    assert.ok(definitions.some(definition => definition.function.name === 'knowledge_search'));
    return { message: { role: 'assistant', content: '继续回答' } };
  } };
  const agent = createAgent({ messages, provider, tools: [{ ...tool, name: 'knowledge_search' }], save: async history => { saved = structuredClone(history); } });
  await agent.run('解释项目');
  assert.equal(messages[0].content, originalSystem);
  assert.equal(saved[0].content, originalSystem);
});

test('检索提示同样占用上下文预算，过小预算在请求模型前失败', async () => {
  let requested = false;
  const agent = createAgent({
    messages: [{ role: 'system', content: '旧提示' }], tools: [{ ...tool, name: 'knowledge_search' }], maxContextChars: 100,
    provider: { complete() { requested = true; throw new Error('不应请求'); } },
  });
  await assert.rejects(agent.run('项目？'), /上下文过长/);
  assert.equal(requested, false);
});
