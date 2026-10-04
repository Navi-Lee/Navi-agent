import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'learning-demo', version: '1.0.0' });

server.registerTool('current_time', {
  description: '获取当前时间，返回 UTC 和 Asia/Shanghai 两种表示。',
  inputSchema: z.strictObject({}),
}, async () => {
  const now = new Date();
  const result = {
    utc: now.toISOString(),
    shanghai: new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now),
    timeZone: 'Asia/Shanghai',
  };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});

server.registerTool('calculate', {
  description: '进行一次四则运算：add、subtract、multiply 或 divide。',
  inputSchema: z.strictObject({ operation: z.enum(['add', 'subtract', 'multiply', 'divide']), left: z.number().finite(), right: z.number().finite() }),
}, async ({ operation, left, right }) => {
  let result;
  // 运算范围清晰、容易学习，也避免把模型传来的字符串当代码执行。
  switch (operation) {
    case 'add': result = left + right; break;
    case 'subtract': result = left - right; break;
    case 'multiply': result = left * right; break;
    case 'divide':
      if (right === 0) return { isError: true, content: [{ type: 'text', text: '除数不能为 0' }] };
      result = left / right;
      break;
  }
  if (!Number.isFinite(result)) return { isError: true, content: [{ type: 'text', text: '运算结果超出有限数字范围' }] };
  const output = { operation, left, right, result };
  return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
});

// stdout 是 MCP 消息通道，不能 console.log 调试文字；调试请用 console.error。
await server.connect(new StdioServerTransport());
// 父程序关闭输入管道后退出，使 SDK 清理连接时不必等待强制终止。
process.stdin.on('end', () => { void server.close().finally(() => process.exit()); });
