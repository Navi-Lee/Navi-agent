import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { safePath } from './tools.js';

// 配置是用户选择要启动的程序，不是模型或资料可以修改的工具参数。
// 这里只接受小而明确的格式，第三方服务不能在配置里自称“无需确认”。
export async function loadMcpConfig(workspace, configPath) {
  const file = await safePath(workspace, configPath);
  if (!(await lstat(file)).isFile()) throw new Error('MCP 配置必须是文件');
  if ((await lstat(file)).size > 100000) throw new Error('MCP 配置超过 100KB');
  let config;
  try { config = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error('MCP 配置不是有效 JSON'); }
  if (!config || Array.isArray(config) || typeof config !== 'object' ||
      Object.keys(config).some(key => key !== 'servers') || !Array.isArray(config.servers) || config.servers.length > 10) {
    throw new Error('MCP 配置格式应为 { "servers": [{ "name", "command", "args" }] }，最多 10 个服务');
  }
  const names = new Set();
  return config.servers.map(server => {
    if (!server || typeof server !== 'object' || Array.isArray(server) ||
        Object.keys(server).some(key => !['name', 'command', 'args'].includes(key)) ||
        typeof server.name !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(server.name) ||
        typeof server.command !== 'string' || !server.command.trim() || server.command.includes('\0') ||
        !Array.isArray(server.args) || server.args.length > 100 ||
        server.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
      throw new Error('MCP 服务需要 name（字母/数字/下划线/短横线）、command 和字符串数组 args');
    }
    if (names.has(server.name)) throw new Error(`MCP 服务名称重复：${server.name}`);
    names.add(server.name);
    // 相对参数文件路径按配置文件所在目录解释，切换 workspace 后行为仍明确。
    return { ...server, cwd: path.dirname(file) };
  });
}
