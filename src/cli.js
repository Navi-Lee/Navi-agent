import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import { createDeepSeekProvider } from './provider.js';
import { createAgent } from './agent.js';
import { createTools } from './tools.js';
import { createSessionStore } from './session.js';
import { fileURLToPath } from 'node:url';
import { createKnowledgeTool } from './knowledge.js';
import { connectMcpServers } from './mcp.js';
import { loadMcpConfig } from './mcp-config.js';

async function main() {
  const { values } = parseArgs({ options: {
    prompt: { type: 'string' },
    workspace: { type: 'string' },
    session: { type: 'string' },
    knowledge: { type: 'string' },
    'mcp-demo': { type: 'boolean' },
    'mcp-config': { type: 'string' },
    yes: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } });
  const help = '用法：npm start -- [--prompt "任务"] [--workspace 路径] [--session ID] [--yes]\n资料范围：--knowledge 路径（默认工作目录）\nMCP：--mcp-demo 或 --mcp-config 配置文件路径\n交互命令：/help /tools /new /sessions /exit';
  if (values.help) { console.log(help); return; }
  const workspace = await realpath(path.resolve(values.workspace ?? process.cwd()));
  const provider = createDeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY, baseUrl: process.env.DEEPSEEK_BASE_URL, model: process.env.DEEPSEEK_MODEL });
  const store = createSessionStore(workspace);
  let id = values.session ?? store.newId();
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let controller = new AbortController();
  let mcp, agent;
  const cancel = () => {
    if (controller) { controller.abort(); console.log('\n正在取消当前任务…'); }
    else rl.close();
  };
  process.on('SIGINT', cancel);
  rl.on('SIGINT', cancel);
  const approve = async ({ preview, signal }) => {
    console.log(`\n${preview}`);
    if (values.yes) return true;
    if (!terminal) { console.log('非交互模式未授权，操作已拒绝。'); return false; }
    return /^(y|yes)$/i.test((await rl.question('执行？[y/N] ', { signal })).trim());
  };
  const tools = [];
  const makeAgent = messages => createAgent({
    provider, tools, ...(messages ? { messages } : {}), approve,
    save: messages => store.save(id, messages),
    onEvent(event) {
      if (event.type === 'tool_start') console.log(`[工具] ${event.name}`);
      if (event.type === 'tool_end') console.log(`[${event.ok ? '完成' : '失败'}] ${event.name}`);
      if (event.type === 'trim') console.log('[上下文] 已移除最早的完整对话轮次');
      if (event.type === 'usage') console.log(`[Token] 输入 ${event.usage.prompt_tokens} / 输出 ${event.usage.completion_tokens} / 合计 ${event.usage.total_tokens}`);
    },
  });
  const run = async input => {
    // 每个任务有独立的取消开关；取消本次任务后仍可继续下一轮。
    controller = new AbortController();
    try {
      const result = await agent.run(input, { signal: controller.signal });
      console.log(`\n${result.content}\n`);
      return true;
    } catch (error) {
      console.error(`任务未完成：${controller.signal.aborted ? '已取消' : error.message}`);
      return false;
    } finally { controller = undefined; }
  };
  try {
    // 三种工具最后都交给同一个循环，不为 RAG 或 MCP 另建一套 agent。
    tools.push(...createTools(workspace).map(tool => ({ ...tool, source: '本地工具' })));
    tools.push({ ...createKnowledgeTool(workspace, { root: values.knowledge ?? '.' }), source: '本地资料/RAG' });
    const servers = values['mcp-config'] ? await loadMcpConfig(workspace, values['mcp-config']) : [];
    if (values['mcp-demo']) servers.push({
      name: 'demo', command: process.execPath,
      args: [fileURLToPath(new URL('../examples/mcp-server.js', import.meta.url))],
      cwd: workspace, trustedReadOnly: ['current_time', 'calculate'],
    });
    if (servers.length) {
      mcp = await connectMcpServers(servers, { signal: controller.signal });
      tools.push(...mcp.tools);
    }
    controller.signal.throwIfAborted();
    agent = makeAgent(values.session ? await store.load(id) : undefined);
    controller = undefined;
    console.log(`工作目录：${workspace}\n会话：${id}`);
    console.log(`已加载 ${tools.length} 个工具；资料范围：${values.knowledge ?? '.'}`);
    if (values.prompt !== undefined) { if (!await run(values.prompt)) process.exitCode = 1; return; }
    if (!terminal) throw new Error('非交互环境请使用 --prompt');
    console.log(help);
    while (!rl.closed) {
      let input; try { input = (await rl.question('你> ')).trim(); } catch (e) { if (rl.closed) break; throw e; }
      if (!input) continue;
      if (input === '/exit') break;
      if (input === '/help') { console.log(help); continue; }
      if (input === '/tools') { console.log(tools.map(tool => `${tool.name} [${tool.source}]\n  ${tool.description}`).join('\n')); continue; }
      if (input === '/sessions') { console.log((await store.list()).join('\n') || '暂无会话'); continue; }
      if (input === '/new') { await store.save(id, agent.messages); id = store.newId(); agent = makeAgent(); console.log(`新会话：${id}`); continue; }
      await run(input);
    }
  } finally {
    // 即使保存会话失败，也关闭 MCP 子进程和输入界面。
    try { if (agent) await store.save(id, agent.messages); }
    finally { rl.close(); process.removeListener('SIGINT', cancel); await mcp?.close(); }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
