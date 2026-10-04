import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safePath, createTools, runCommand, fetchPage } from '../src/tools.js';
import { createSessionStore } from '../src/session.js';
import { createAgent } from '../src/agent.js';

async function temp(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'harness-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
test('文件工具边界和完整读写授权流程', async t => {
  const root = await temp(t); await writeFile(path.join(root, 'a.txt'), 'before');
  await assert.rejects(safePath(root, '../outside'), /超出/); await assert.rejects(safePath(root, '.env'), /禁止/);
  let step = 0, approvals = 0;
  const provider = { async complete(messages) { const name = step === 0 ? 'read_file' : 'write_file'; if (step++ < 2) return { message: { role: 'assistant', content: null, tool_calls: [{ id: String(step), type: 'function', function: { name, arguments: JSON.stringify(name === 'read_file' ? { path: 'a.txt' } : { path: 'a.txt', content: 'after' }) } }] } }; assert.equal(JSON.parse(messages.at(-1).content).ok, true); return { message: { role: 'assistant', content: 'done' } }; } };
  const agent = createAgent({ provider, tools: createTools(root), approve: async ({ preview }) => { approvals++; assert.match(preview, /before/); assert.match(preview, /after/); return true; } });
  await agent.run('edit'); assert.equal(approvals, 1); assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'after');
});
test('符号链接越界，包括尚不存在的目标', async t => {
  const root = await temp(t); const outside = await temp(t);
  try { await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { if (e.code === 'EPERM') return t.skip('环境禁止创建符号链接'); throw e; }
  await assert.rejects(safePath(root, 'link/new.txt'), /符号链接/);
  await symlink(outside, path.join(root, '.agent'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createSessionStore(root).save('test', []), /符号链接/);
});
test('会话持久化、列举、恢复和 ID 校验', async t => {
  const root = await temp(t); const store = createSessionStore(root); const messages = [{ role: 'system', content: 'test' }, { role: 'user', content: 'hi' }];
  await store.save('session', messages); await store.save('session', messages);
  assert.deepEqual(await store.load('session'), messages); assert.deepEqual(await store.list(), ['session']); await assert.rejects(store.load('../bad'), /无效/);
});
test('目录、搜索和网页私网限制', async t => {
  const root = await temp(t); await mkdir(path.join(root, 'sub')); await writeFile(path.join(root, 'sub', 'a.txt'), 'hello\nneedle'); await writeFile(path.join(root, '.env'), 'secret');
  const tools = new Map(createTools(root).map(tool => [tool.name, tool]));
  assert.ok(!(await tools.get('list_directory').execute({ path: '.' })).some(e => e.name === '.env'));
  assert.equal((await tools.get('search_text').execute({ path: '.', query: 'needle' }, {})).matches[0].line, 2);
  await assert.rejects(fetchPage('http://127.0.0.1'), /禁止/); await assert.rejects(fetchPage('file:///tmp/a'), /仅允许/);
});
test('命令输出上限、超时及取消', async t => {
  const root = await temp(t);
  const node = `${process.platform === 'win32' ? '& ' : ''}"${process.execPath}"`;
  const outputCommand = process.platform === 'win32' ? "Write-Output ('x' * 1000)" : `${node} -e "console.log('x'.repeat(1000))"`;
  const waitCommand = process.platform === 'win32' ? 'Start-Sleep -Seconds 10' : `${node} -e "setTimeout(()=>{},10000)"`;
  const output = await runCommand(outputCommand, root, { maxOutput: 30 }); assert.equal(output.truncated, true); assert.equal(output.output.length, 30);
  const started = Date.now(); const result = await runCommand(waitCommand, root, { timeoutMs: 500 }); assert.equal(result.timedOut, true); assert.ok(Date.now() - started < 5000, '超时必须真正停止进程');
  const controller = new AbortController(); const pending = runCommand(waitCommand, root, { signal: controller.signal }); setTimeout(() => controller.abort(), 200); await assert.rejects(pending, /取消/);
});
