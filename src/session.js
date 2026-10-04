import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeStatePath as safePath } from './tools.js';

export function createSessionStore(workspace) {
  const valid = id => { if (!/^[\w-]{1,100}$/.test(id)) throw new Error('无效的会话 ID'); return id; };
  const directory = () => safePath(workspace, '.agent/sessions');
  return {
    newId: () => randomUUID(),
    async save(id, messages) {
      valid(id);
      const dir = await directory();
      await mkdir(dir, { recursive: true });
      const destination = await safePath(workspace, `.agent/sessions/${id}.json`);
      const temporary = await safePath(workspace, `.agent/sessions/${id}.${randomUUID()}.tmp`);
      // 先写新文件，再替换旧文件，避免一次写入中断就破坏已有会话。
      await writeFile(temporary, JSON.stringify({ version: 1, id, updatedAt: new Date().toISOString(), messages }, null, 2), { flag: 'wx' });
      await rename(temporary, destination);
    },
    async load(id) {
      const data = JSON.parse(await readFile(await safePath(workspace, `.agent/sessions/${valid(id)}.json`), 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.messages) || data.messages[0]?.role !== 'system') throw new Error('会话格式无效');
      return data.messages;
    },
    async list() { try { return (await readdir(await directory())).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)).sort(); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } },
  };
}
