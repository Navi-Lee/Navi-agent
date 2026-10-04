import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connectMcpServers } from '../src/mcp.js';
import { createAgent } from '../src/agent.js';

const demoFile = fileURLToPath(new URL('../examples/mcp-server.js', import.meta.url));
const fixtureFile = fileURLToPath(new URL('../fixtures/mcp-test-server.js', import.meta.url));
const demo = () => ({ name: 'demo', command: process.execPath, args: [demoFile], trustedReadOnly: ['current_time', 'calculate'] });
const fixture = (mode = 'normal', pidFile) => ({ name: 'external', command: process.execPath, args: [fixtureFile, mode, ...(pidFile ? [pidFile] : [])] });
const find = (mcp, name) => mcp.tools.find(tool => tool.name.endsWith(`__${name}`));
const call = (name, args = {}) => ({ id: 'mcp-call', type: 'function', function: { name, arguments: JSON.stringify(args) } });

async function connect(t, servers = [demo()], options) {
  const mcp = await connectMcpServers(servers, options);
  t.after(() => mcp.close());
  return mcp;
}
async function stopped(pid) {
  for (let retry = 0; retry < 50; retry++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(20);
  }
  assert.fail(`MCP 子进程 ${pid} 未退出`);
}
async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'learning-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('MCP 真正发现两个示例工具，双时区时间和四则运算均可调用', async t => {
  const mcp = await connect(t);
  assert.deepEqual(mcp.tools.map(tool => tool.name), ['mcp__demo__current_time', 'mcp__demo__calculate']);
  assert.ok(mcp.tools.every(tool => !tool.preview && tool.source === 'MCP/demo'));
  const time = (await find(mcp, 'current_time').execute({})).structuredContent;
  assert.ok(Number.isFinite(Date.parse(time.utc)));
  assert.equal(time.timeZone, 'Asia/Shanghai');
  assert.match(time.shanghai, /\d{4}\/\d{2}\/\d{2}/);
  for (const [operation, result] of [['add', 8], ['subtract', 4], ['multiply', 12], ['divide', 3]]) {
    assert.equal((await find(mcp, 'calculate').execute({ operation, left: 6, right: 2 })).structuredContent.result, result);
  }
});

test('MCP inputSchema 校验对象、必填字段、类型、枚举、额外参数，并把服务端 isError 转为失败', async t => {
  const mcp = await connect(t), calculate = find(mcp, 'calculate');
  for (const args of [null, [], {}, { operation: 'eval', left: 1, right: 2 }, { operation: 'add', left: '1', right: 2 }, { operation: 'add', left: 1, right: 2, code: 'bad' }]) {
    assert.throws(() => calculate.validate(args), /参数/);
  }
  await assert.rejects(calculate.execute({ operation: 'divide', left: 1, right: 0 }), /除数不能为 0/);
  await assert.rejects(calculate.execute({ operation: 'multiply', left: Number.MAX_VALUE, right: 2 }), /有限数字范围/);
});

test('MCP → agent → 模拟模型：工具结果回传、最终回答和事件完整', async t => {
  const mcp = await connect(t), events = [];
  let step = 0;
  const provider = { async complete(messages, definitions) {
    assert.ok(definitions.some(definition => definition.function.name === 'mcp__demo__calculate'));
    if (step++ === 0) return { message: { role: 'assistant', content: null, tool_calls: [call('mcp__demo__calculate', { operation: 'multiply', left: 3, right: 4 })] } };
    const result = JSON.parse(messages.at(-1).content);
    assert.equal(result.ok, true); assert.equal(result.result.structuredContent.result, 12);
    return { message: { role: 'assistant', content: '计算结果是 12。' } };
  } };
  const agent = createAgent({ provider, tools: mcp.tools, onEvent: event => events.push(event) });
  assert.equal((await agent.run('3 乘以 4')).content, '计算结果是 12。');
  assert.equal(events.filter(event => event.type === 'tool_start').length, 1);
  assert.equal(events.find(event => event.type === 'tool_end').ok, true);
});

test('第三方 MCP 默认确认，不能靠 readOnlyHint 或伪造 trustedReadOnly 绕过；拒绝时服务未执行', async t => {
  const config = { ...fixture(), trustedReadOnly: ['echo'] }, mcp = await connect(t, [config]);
  const echo = find(mcp, 'echo');
  assert.equal(typeof echo.preview, 'function');
  let approvals = 0;
  const provider = { async complete(messages) {
    if (messages.at(-1).role === 'user') return { message: { role: 'assistant', tool_calls: [call(echo.name, { value: 'hello' })] } };
    assert.equal(JSON.parse(messages.at(-1).content).error, '用户拒绝授权');
    return { message: { role: 'assistant', content: '调用被拒绝。' } };
  } };
  await createAgent({ provider, tools: mcp.tools, approve: async request => { approvals++; assert.match(request.preview, /external|echo|hello/); return false; } }).run('调用 echo');
  assert.equal(approvals, 1);
  assert.equal((await find(mcp, 'info').execute({})).structuredContent.executions, 0);
  const approvedProvider = { async complete(messages) {
    if (messages.at(-1).role === 'user') return { message: { role: 'assistant', tool_calls: [call(echo.name, { value: 'approved' })] } };
    assert.equal(JSON.parse(messages.at(-1).content).ok, true);
    return { message: { role: 'assistant', content: '已调用。' } };
  } };
  await createAgent({ provider: approvedProvider, tools: mcp.tools, approve: async () => true }).run('批准调用');
  assert.equal((await find(mcp, 'info').execute({})).structuredContent.executions, 1);
});

test('MCP 调用超时和取消会中止请求，之后仍可使用连接', async t => {
  const mcp = await connect(t, [fixture()]), slow = find(mcp, 'slow');
  await assert.rejects(slow.execute({ delayMs: 2000 }, { timeoutMs: 100 }), /超时/);
  const controller = new AbortController();
  const pending = slow.execute({ delayMs: 2000 }, { signal: controller.signal });
  const rejected = assert.rejects(pending, /用户取消任务/);
  setTimeout(() => controller.abort(), 100);
  await rejected;
  const info = (await find(mcp, 'info').execute({})).structuredContent;
  assert.equal(info.cancelled, 2);
});

test('MCP 非文本返回省略 base64，保留文本和小的结构化数据', async t => {
  const mcp = await connect(t, [fixture()]);
  const result = await find(mcp, 'media').execute({});
  assert.deepEqual(result.content[0], { type: 'image', mimeType: 'image/png', uri: undefined, omitted: true });
  assert.equal(result.content[1].text, '图片已生成');
  assert.equal(result.structuredContent.summary, '保留小的结构化结果');
  assert.ok(JSON.stringify(result).length < 500);
});

test('MCP 断连和主动关闭返回清晰错误，close 幂等且真正回收子进程', async t => {
  const mcp = await connect(t, [fixture()]);
  const pid = (await find(mcp, 'info').execute({})).structuredContent.pid;
  await mcp.close(); await mcp.close(); await stopped(pid);
  await assert.rejects(find(mcp, 'info').execute({}), /关闭|断开/);
  const disconnected = await connect(t, [fixture()]);
  const otherPid = (await find(disconnected, 'info').execute({})).structuredContent.pid;
  await assert.rejects(find(disconnected, 'disconnect').execute({}), /MCP/);
  await stopped(otherPid);
  await assert.rejects(find(disconnected, 'info').execute({}), /关闭|断开/);
});

test('MCP 启动失败会关闭此前已启动的服务', async t => {
  const root = await temp(t), pidFile = path.join(root, 'pid.txt');
  await assert.rejects(connectMcpServers([fixture('normal', pidFile), { name: 'missing', command: path.join(root, 'does-not-exist'), args: [] }]), /missing/);
  await stopped(Number(await readFile(pidFile, 'utf8')));
});

test('MCP 启动超时和启动取消也会清理子进程', async t => {
  const root = await temp(t), timeoutPid = path.join(root, 'timeout.txt');
  await assert.rejects(connectMcpServers([fixture('silent', timeoutPid)], { timeoutMs: 1500 }), /超时/);
  await stopped(Number(await readFile(timeoutPid, 'utf8')));
  const cancelPid = path.join(root, 'cancel.txt'), controller = new AbortController();
  const rejected = assert.rejects(connectMcpServers([fixture('silent', cancelPid)], { signal: controller.signal }), /用户取消任务/);
  for (let retry = 0; retry < 100; retry++) {
    try { await readFile(cancelPid); break; } catch (error) { if (error.code !== 'ENOENT') throw error; await delay(20); }
  }
  controller.abort(); await rejected;
  await stopped(Number(await readFile(cancelPid, 'utf8')));
});

test('MCP 配置错误、重复名称和规范化工具名冲突会明确失败；长名字合法且不重复', async t => {
  for (const servers of [null, [{}], [demo(), demo()]]) await assert.rejects(connectMcpServers(servers), /配置|数组|重复/);
  await assert.rejects(connectMcpServers([fixture('collision')]), /冲突/);
  const mcp = await connect(t, [{ ...demo(), name: '中文 名字'.repeat(20) }]);
  assert.equal(new Set(mcp.tools.map(tool => tool.name)).size, mcp.tools.length);
  assert.ok(mcp.tools.every(tool => /^[a-zA-Z0-9_-]{1,63}$/.test(tool.name)));
});
