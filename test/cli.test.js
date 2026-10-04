import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

test('真实 CLI + 模拟 API：读取、写入提议、授权策略、回答和会话', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'note.txt'), 'before');
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const { messages } = JSON.parse(body);
    const results = messages.filter(m => m.role === 'tool');
    let message;
    if (results.length === 0) message = { role: 'assistant', content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"note.txt"}' } }] };
    else if (results.length === 1) message = { role: 'assistant', content: null, tool_calls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: '{"path":"note.txt","content":"after"}' } }] };
    else message = { role: 'assistant', content: JSON.parse(results.at(-1).content).ok ? '修改完成' : '写入被拒绝' };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 1 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const run = yes => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), '--workspace', root, '--prompt', 'edit', ...(yes ? ['--yes'] : [])], { env: { ...process.env, DEEPSEEK_API_KEY: 'fake-key-for-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; }); child.on('error', reject); child.on('close', code => resolve({ code, output }));
  });
  const denied = await run(false); assert.equal(denied.code, 0, denied.output); assert.match(denied.output, /写入被拒绝/); assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'before');
  const allowed = await run(true); assert.equal(allowed.code, 0, allowed.output); assert.match(allowed.output, /修改完成/); assert.match(allowed.output, /原内容/); assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'after');
  for (const file of await readdir(path.join(root, '.agent', 'sessions'))) {
    const saved = await readFile(path.join(root, '.agent', 'sessions', file), 'utf8');
    assert.ok(!saved.includes('fake-key-for-test'));
    assert.equal(JSON.parse(saved).messages.filter(m => m.role === 'tool').length, 2);
  }
});

test('CLI 接入资料范围及真实 MCP 示例，保存完整工具结果', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'learning-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'notes'));
  await writeFile(path.join(root, 'notes', 'guide.md'), '# 接线说明\n接线是把工具加入同一个循环。');
  let requests = 0, failure;
  const server = http.createServer(async (req, res) => {
    try {
      let body = ''; for await (const part of req) body += part;
      const { messages, tools } = JSON.parse(body);
      requests++;
      assert.ok(tools.some(tool => tool.function.name === 'knowledge_search'));
      assert.ok(tools.some(tool => tool.function.name === 'mcp__demo__calculate'));
      assert.match(messages[0].content, /先使用 knowledge_search/);
      const results = messages.filter(message => message.role === 'tool');
      let message;
      if (!results.length) message = { role: 'assistant', content: null, tool_calls: [
        { id: 'knowledge', type: 'function', function: { name: 'knowledge_search', arguments: '{"query":"接线"}' } },
        { id: 'calculate', type: 'function', function: { name: 'mcp__demo__calculate', arguments: '{"operation":"multiply","left":12,"right":8}' } },
      ] };
      else {
        assert.equal(results.length, 2);
        const knowledge = JSON.parse(results[0].content), calculation = JSON.parse(results[1].content);
        assert.equal(knowledge.ok, true);
        assert.equal(knowledge.result.root, 'notes');
        assert.equal(knowledge.result.matches[0].path, 'notes/guide.md');
        assert.equal(calculation.ok, true);
        assert.equal(calculation.result.structuredContent.result, 96);
        message = { role: 'assistant', content: '接线说明来自 notes/guide.md:1-2，计算结果为 96。' };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 2 } }));
    } catch (error) { failure = error; res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), '--workspace', root, '--knowledge', 'notes', '--mcp-demo', '--prompt', '接线说明与计算'], {
      env: { ...process.env, DEEPSEEK_API_KEY: 'fake-cli-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}` }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
  });
  if (failure) throw failure;
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /notes\/guide.md:1-2/);
  assert.equal(requests, 2);
  const savedFiles = await readdir(path.join(root, '.agent', 'sessions'));
  const saved = await readFile(path.join(root, '.agent', 'sessions', savedFiles[0]), 'utf8');
  assert.ok(!saved.includes('fake-cli-key'));
  assert.deepEqual(JSON.parse(saved).messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['knowledge', 'calculate']);
});

test('CLI 真实外部 MCP 配置：配置目录作为 cwd，默认拒绝、--yes 允许并保存结果', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'configured-mcp-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'services');
  await mkdir(configDir);
  const bootstrap = path.join(configDir, 'configured-server.mjs');
  // 启动真实示例服务前留下 cwd 记录，验证相对文件确实落在配置目录中。
  await writeFile(bootstrap, `import { writeFile } from 'node:fs/promises';
await writeFile('started-in.txt', process.cwd());
await import(${JSON.stringify(new URL('../examples/mcp-server.js', import.meta.url).href)});
`);
  await writeFile(path.join(configDir, 'mcp.json'), JSON.stringify({ servers: [{ name: 'configured', command: process.execPath, args: [bootstrap] }] }));
  let requests = 0, failure;
  const server = http.createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const { messages, tools } = JSON.parse(body);
      requests++;
      assert.ok(tools.some(tool => tool.function.name === 'mcp__configured__calculate'));
      const results = messages.filter(message => message.role === 'tool');
      const message = results.length === 0
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'configured-call', type: 'function', function: { name: 'mcp__configured__calculate', arguments: '{"operation":"multiply","left":7,"right":8}' } }] }
        : { role: 'assistant', content: JSON.parse(results[0].content).ok ? '外部 MCP 计算结果为 56。' : '外部 MCP 调用被拒绝。' };
      if (results.length) {
        const result = JSON.parse(results[0].content);
        if (result.ok) assert.equal(result.result.structuredContent.result, 56);
        else assert.equal(result.error, '用户拒绝授权');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 2 } }));
    } catch (error) { failure = error; res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const run = yes => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), '--workspace', root, '--mcp-config', 'services/mcp.json', '--prompt', '计算 7 乘以 8', ...(yes ? ['--yes'] : [])], {
      cwd: root, env: { ...process.env, DEEPSEEK_API_KEY: 'fake-configured-cli-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}` }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
  });
  const denied = await run(false), approved = await run(true);
  if (failure) throw failure;
  assert.equal(denied.code, 0, denied.output); assert.equal(approved.code, 0, approved.output);
  assert.match(denied.output, /外部 MCP 调用被拒绝/);
  assert.match(approved.output, /外部 MCP 计算结果为 56/);
  for (const output of [denied.output, approved.output]) {
    assert.match(output, /MCP 服务：configured/); assert.match(output, /工具：calculate/); assert.match(output, /"left": 7/);
  }
  assert.equal(await readFile(path.join(configDir, 'started-in.txt'), 'utf8'), configDir);
  assert.equal(requests, 4);
  for (const [output, ok] of [[denied.output, false], [approved.output, true]]) {
    const id = output.match(/会话：([^\r\n]+)/)[1];
    const saved = await readFile(path.join(root, '.agent', 'sessions', `${id}.json`), 'utf8');
    assert.ok(!saved.includes('fake-configured-cli-key'));
    const results = JSON.parse(saved).messages.filter(message => message.role === 'tool');
    assert.equal(results.length, 1); assert.equal(results[0].tool_call_id, 'configured-call');
    assert.equal(JSON.parse(results[0].content).ok, ok);
  }
});
