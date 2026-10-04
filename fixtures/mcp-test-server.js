// 仅供集成测试使用：真实 MCP 服务，用来制造超时、断连和非文本结果。
import { writeFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const [mode = 'normal', pidFile] = process.argv.slice(2);
if (pidFile) await writeFile(pidFile, String(process.pid));
if (mode === 'silent') {
  process.stdin.resume();
  process.stdin.on('end', () => process.exit());
  setInterval(() => {}, 1000);
} else {
  const server = new McpServer({ name: 'test-server', version: '1.0.0' });
  let executions = 0, cancelled = 0;
  const info = () => ({ pid: process.pid, executions, cancelled, hasApiKey: Boolean(process.env.DEEPSEEK_API_KEY) });
  const reply = output => ({ content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output });
  server.registerTool('info', { inputSchema: z.strictObject({}) }, async () => reply(info()));
  server.registerTool('echo', {
    inputSchema: z.strictObject({ value: z.string().min(1) }),
    annotations: { readOnlyHint: true },
  }, async ({ value }) => { executions++; return reply({ value }); });
  server.registerTool('slow', { inputSchema: z.strictObject({ delayMs: z.number().int().min(1).max(60000) }) }, async ({ delayMs }, ctx) => {
    await new Promise(resolve => {
      const timer = setTimeout(() => { ctx.mcpReq.signal.removeEventListener('abort', abort); resolve(); }, delayMs);
      const abort = () => { cancelled++; clearTimeout(timer); resolve(); };
      ctx.mcpReq.signal.addEventListener('abort', abort, { once: true });
    });
    return reply({ finished: true });
  });
  server.registerTool('disconnect', { inputSchema: z.strictObject({}) }, async () => process.exit());
  server.registerTool('media', { inputSchema: z.strictObject({}) }, async () => ({
    content: [{ type: 'image', mimeType: 'image/png', data: 'a'.repeat(100000) }, { type: 'text', text: '图片已生成' }],
    structuredContent: { summary: '保留小的结构化结果' },
  }));
  if (mode === 'collision') {
    for (const name of ['same.name', 'same/name']) server.registerTool(name, { inputSchema: z.strictObject({}) }, async () => reply({}));
  }
  await server.connect(new StdioServerTransport());
  process.stdin.on('end', () => { void server.close().finally(() => process.exit()); });
}
