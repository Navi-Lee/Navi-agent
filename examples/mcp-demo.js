import { fileURLToPath } from 'node:url';
import { connectMcpServers } from '../src/mcp.js';

// 不用模型、不用 API key：直接观察客户端发现并调用服务端工具的全过程。
const mcp = await connectMcpServers([{
  name: 'demo', command: process.execPath,
  args: [fileURLToPath(new URL('./mcp-server.js', import.meta.url))],
  trustedReadOnly: ['current_time', 'calculate'],
}]);
try {
  console.log('发现 MCP 工具：', mcp.tools.map(tool => tool.name).join(', '));
  const time = await mcp.tools.find(tool => tool.name === 'mcp__demo__current_time').execute({});
  console.log('当前时间：', time.structuredContent);
  const sum = await mcp.tools.find(tool => tool.name === 'mcp__demo__calculate').execute({ operation: 'add', left: 2, right: 3 });
  console.log('2 + 3 =', sum.structuredContent.result);
} finally {
  await mcp.close();
  console.log('MCP 连接已关闭，示例服务已退出。');
}
