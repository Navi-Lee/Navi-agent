import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadMcpConfig } from '../src/mcp-config.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'learning-mcp-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('MCP 配置加载：cwd 按配置位置解释，不接受免授权字段', async t => {
  const root = await fixture(t), file = path.join(root, 'mcp.json');
  const server = { name: 'example', command: 'node', args: ['server.js'] };
  await writeFile(file, JSON.stringify({ servers: [server] }));
  assert.deepEqual(await loadMcpConfig(root, 'mcp.json'), [{ ...server, cwd: root }]);
  for (const bad of [
    { servers: [{ ...server, trustedReadOnly: ['calculate'] }] },
    { servers: [{ ...server, cwd: '../outside' }] },
    { servers: [server, server] },
    { servers: [{ ...server, args: ['x', 1] }] },
    { servers: [{ ...server, name: 'bad/name' }] },
    { servers: [server], extra: true },
  ]) {
    await writeFile(file, JSON.stringify(bad));
    await assert.rejects(loadMcpConfig(root, file), /配置|服务|重复/);
  }
});

test('MCP 配置拒绝无效 JSON、过大文件、目录、秘密和越界路径', async t => {
  const root = await fixture(t), file = path.join(root, 'mcp.json');
  await writeFile(file, '{bad');
  await assert.rejects(loadMcpConfig(root, file), /JSON/);
  await writeFile(file, ' '.repeat(100001));
  await assert.rejects(loadMcpConfig(root, file), /100KB/);
  await assert.rejects(loadMcpConfig(root, '.'), /文件/);
  await assert.rejects(loadMcpConfig(root, '.env'), /禁止/);
  await assert.rejects(loadMcpConfig(root, '../outside.json'), /超出/);
});
