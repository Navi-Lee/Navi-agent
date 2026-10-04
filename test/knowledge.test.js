import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { createKnowledgeTool } from '../src/knowledge.js';
import { createAgent } from '../src/agent.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-knowledge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, tool: createKnowledgeTool(directory) };
}

test('中文主题和英文代码名能检索，命中词数量优先于次数', async t => {
  const { directory, tool } = await fixture(t);
  await writeFile(path.join(directory, 'a.md'), '会话保存时调用 createAgent。\n');
  await writeFile(path.join(directory, 'b.js'), 'createAgent createAgent createAgent\n');
  const result = await tool.execute({ query: '会话保存 createAgent' });
  assert.equal(result.matches[0].path, 'a.md');
  assert.ok(result.matches[0].matchedTerms.includes('会话'));
  assert.ok(result.matches[0].matchedTerms.includes('保存'));
  assert.ok(result.matches[0].matchedTerms.includes('createagent'));
  assert.equal((await tool.execute({ query: 'create agent' })).matches[0].path, 'b.js');
});

test('相同命中词按次数、路径排序，最多返回 5 片段', async t => {
  const { directory, tool } = await fixture(t);
  for (const name of ['b', 'c', 'd', 'e', 'f', 'g']) await writeFile(path.join(directory, `${name}.txt`), 'retrieval\n');
  await writeFile(path.join(directory, 'a.txt'), 'retrieval retrieval\n');
  const result = await tool.execute({ query: 'retrieval' });
  assert.deepEqual(result.matches.map(match => match.path), ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
  assert.equal(result.matches[0].occurrences, 2);
  assert.equal(result.totalMatches, 7);
});

test('切分片段保留 CRLF 源码的真实行号，约 1000 字符并有重叠', async t => {
  const { directory, tool } = await fixture(t);
  const lines = Array.from({ length: 80 }, (_, i) => `行${i + 1} ${'资料'.repeat(10)}${i === 45 ? ' 引用定位' : ''}`);
  const text = lines.join('\r\n');
  await writeFile(path.join(directory, 'notes.md'), text);
  const result = await tool.execute({ query: '引用定位' });
  assert.ok(result.matches.length >= 1);
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  for (const match of result.matches) {
    const start = text.indexOf(match.text);
    const end = start + match.text.length - 1;
    assert.equal(match.startLine, starts.filter(offset => offset <= start).length);
    assert.equal(match.endLine, starts.filter(offset => offset <= end).length);
    assert.equal(start, starts[match.startLine - 1], '普通短行的片段必须从行首开始');
    assert.ok(match.startLine <= 46 && match.endLine >= 46);
    assert.ok(match.text.length <= 1000);
  }
  const all = (await tool.execute({ query: '资料' })).matches.sort((a, b) => a.startLine - b.startLine);
  assert.ok(all.length > 1);
  assert.ok(all[0].endLine >= all[1].startLine);
});

test('对齐行首后保留重叠、不跳过边界关键词，来源行号与完整行一致', async t => {
  const { directory, tool } = await fixture(t);
  const terms = Array.from({ length: 40 }, (_, i) => `boundary${String(i).padStart(2, '0')}`);
  const lines = terms.map(term => `${term} ${'读资料时保留上下文。'.repeat(5)}`);
  const text = `${lines.join('\n')}\n`;
  await writeFile(path.join(directory, 'boundaries.md'), text);
  const result = await tool.execute({ query: terms.join(' ') });
  assert.equal(result.matches.length, result.totalMatches);
  const matches = result.matches.sort((a, b) => a.startLine - b.startLine);
  assert.equal(matches[0].startLine, 1);
  assert.equal(matches.at(-1).endLine, 40);
  for (const match of matches) {
    assert.ok(match.text.startsWith(lines[match.startLine - 1]));
    assert.equal(match.text, `${lines.slice(match.startLine - 1, match.endLine).join('\n')}\n`);
    assert.ok(match.text.length <= 1000);
  }
  for (let i = 1; i < matches.length; i++) {
    const previousEnd = text.indexOf(matches[i - 1].text) + matches[i - 1].text.length;
    const nextStart = text.indexOf(matches[i].text);
    assert.ok(nextStart > text.indexOf(matches[i - 1].text));
    assert.ok(previousEnd - nextStart >= 50 && previousEnd - nextStart <= 300);
  }
  for (const term of terms) assert.ok(matches.some(match => match.text.includes(term)), `${term} 应至少出现在一个片段里`);
});

test('超长单行仍按字符切分，边界词能检索且最后一段不会遗漏', async t => {
  const { directory, tool } = await fixture(t);
  // boundaryMarker 横跨第一块的第 1000 字符，重叠块应保留完整词。
  const text = `${'x '.repeat(496)}boundaryMarker ${'y '.repeat(1000)}finishMarker`;
  await writeFile(path.join(directory, 'long-line.txt'), text);
  const result = await tool.execute({ query: 'boundaryMarker finishMarker' });
  assert.ok(result.matches.some(match => match.text.includes('boundaryMarker')));
  assert.ok(result.matches.some(match => match.text.includes('finishMarker')));
  assert.ok(result.totalMatches <= Math.ceil(text.length / 850));
  for (const match of result.matches) {
    assert.equal(match.startLine, 1);
    assert.equal(match.endLine, 1);
    assert.ok(match.text.length <= 1000);
  }
});

test('无匹配返回空数组，修改资料后下次调用读到更新', async t => {
  const { directory, tool } = await fixture(t);
  const file = path.join(directory, 'notes.txt');
  await writeFile(file, '会话保存\n');
  assert.deepEqual((await tool.execute({ query: '不存在的南极企鹅' })).matches, []);
  await writeFile(file, '知识检索 retrieval\n');
  assert.equal((await tool.execute({ query: 'retrieval' })).matches[0].text, '知识检索 retrieval\n');
  assert.deepEqual((await tool.execute({ query: '会话保存' })).matches, []);
});

test('资料根目录缩小范围，不能越界、指向文件或进入秘密目录', async t => {
  const { directory } = await fixture(t);
  await mkdir(path.join(directory, 'notes'));
  await writeFile(path.join(directory, 'notes', 'inside.md'), 'retrieval\n');
  await writeFile(path.join(directory, 'outside.md'), 'retrieval\n');
  assert.deepEqual((await createKnowledgeTool(directory, { root: 'notes' }).execute({ query: 'retrieval' })).matches.map(match => match.path), ['notes/inside.md']);
  await assert.rejects(createKnowledgeTool(directory, { root: '..' }).execute({ query: 'retrieval' }), /工作目录/);
  await assert.rejects(createKnowledgeTool(directory, { root: 'outside.md' }).execute({ query: 'retrieval' }), /必须是目录/);
  await mkdir(path.join(directory, '.aws'));
  await assert.rejects(createKnowledgeTool(directory, { root: '.aws' }).execute({ query: 'retrieval' }), /忽略目录/);
});

test('跳过秘密、状态、依赖、构建产物、二进制和超大文件', async t => {
  const { directory, tool } = await fixture(t);
  for (const folder of ['.agent', '.git', '.codex', '.aws', 'node_modules', 'dist', 'build', 'target']) {
    await mkdir(path.join(directory, folder));
    await writeFile(path.join(directory, folder, 'hidden.txt'), 'retrieval\n');
  }
  for (const file of ['.env', '.env.example', 'secrets.txt', 'credentials.json', 'api-key.txt', 'private_key.txt', 'mcp.json', 'mcp-config.json', 'mcpServers.json']) await writeFile(path.join(directory, file), 'retrieval\n');
  await writeFile(path.join(directory, 'binary.txt'), Buffer.from('retrieval\0hidden'));
  await writeFile(path.join(directory, 'invalid.txt'), Buffer.from([0xff, 0xfe, 0x72]));
  await writeFile(path.join(directory, 'large.md'), 'retrieval'.repeat(13_000));
  await writeFile(path.join(directory, 'normal.md'), 'retrieval\n');
  const result = await tool.execute({ query: 'retrieval' });
  assert.deepEqual(result.matches.map(match => match.path), ['normal.md']);
  assert.equal(result.scannedFiles, 1);
});

test('符号链接目录（含指向工作目录内部的链接）被跳过，不能作为资料根', async t => {
  const { directory, tool } = await fixture(t);
  await mkdir(path.join(directory, 'real'));
  await writeFile(path.join(directory, 'real', 'notes.md'), 'retrieval\n');
  const link = path.join(directory, 'linked');
  try { await symlink(path.join(directory, 'real'), link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('当前系统不允许创建符号链接'); return; } throw error; }
  assert.deepEqual((await tool.execute({ query: 'retrieval' })).matches.map(match => match.path), ['real/notes.md']);
  await assert.rejects(createKnowledgeTool(directory, { root: 'linked' }).execute({ query: 'retrieval' }), /符号链接/);
});

test('扫描总字节有界，并明确报告资料未全部扫描', async t => {
  const { directory, tool } = await fixture(t);
  for (let i = 0; i < 22; i++) await writeFile(path.join(directory, `${String(i).padStart(2, '0')}.txt`), `retrieval\n${'x'.repeat(99_990)}`);
  const result = await tool.execute({ query: 'retrieval' });
  assert.equal(result.limited, true);
  assert.ok(result.scannedBytes <= 2_000_000);
  assert.ok(result.scannedFiles <= 20);
});

test('扫描目录条目有界，即使多数条目被忽略也会停止', async t => {
  const { directory, tool } = await fixture(t);
  for (let start = 0; start < 2001; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 2001 - start) }, (_, offset) => writeFile(path.join(directory, `.ignored-${start + offset}.txt`), 'retrieval')));
  }
  await writeFile(path.join(directory, 'zzzz.md'), 'retrieval\n');
  const result = await tool.execute({ query: 'retrieval' });
  assert.equal(result.limited, true);
  assert.equal(result.scannedFiles, 0);
  assert.deepEqual(result.matches, []);
});

test('验证查询参数，并响应开始前及执行中的取消', async t => {
  const { directory, tool } = await fixture(t);
  for (const args of [null, {}, { query: '' }, { query: '   ' }, { query: 'x', path: '.' }, { query: 1 }, { query: 'x'.repeat(1001) }]) assert.throws(() => tool.validate(args), /query/);
  const first = new AbortController(); first.abort();
  await assert.rejects(tool.execute({ query: 'retrieval' }, { signal: first.signal }), { name: 'AbortError' });
  await writeFile(path.join(directory, 'notes.md'), 'retrieval\n');
  const second = new AbortController();
  const running = tool.execute({ query: 'retrieval' }, { signal: second.signal });
  second.abort();
  await assert.rejects(running, { name: 'AbortError' });
});

test('模拟模型完成：提出检索、收到片段、根据来源回答', async t => {
  const { directory, tool } = await fixture(t);
  await writeFile(path.join(directory, 'lesson.md'), 'RAG 先查资料，再根据资料回答。\n');
  let step = 0;
  const provider = { async complete(messages, tools) {
    if (step++ === 0) {
      assert.equal(tools[0].function.name, 'knowledge_search');
      return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'search-1', type: 'function', function: { name: 'knowledge_search', arguments: JSON.stringify({ query: 'RAG' }) } }] } };
    }
    const result = JSON.parse(messages.at(-1).content);
    assert.equal(result.ok, true);
    assert.equal(result.result.matches[0].path, 'lesson.md');
    assert.equal(result.result.matches[0].startLine, 1);
    return { message: { role: 'assistant', content: 'RAG 会先查资料，再根据资料回答。来源：lesson.md:1。' } };
  } };
  const agent = createAgent({ provider, tools: [tool] });
  assert.match((await agent.run('RAG 是什么？')).content, /lesson\.md:1/);
  assert.equal(step, 2);
});
