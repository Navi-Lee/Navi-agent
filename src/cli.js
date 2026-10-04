import path from 'node:path';
import { realpath, readdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createDeepSeekProvider } from './provider.js';
import { createAgent } from './agent.js';
import { createTools, safePath } from './tools.js';
import { createSessionStore } from './session.js';
import { fileURLToPath } from 'node:url';
import { createKnowledgeTool } from './knowledge.js';
import { connectMcpServers } from './mcp.js';
import { loadMcpConfig } from './mcp-config.js';
import { createTerminalUI, MenuCancelled } from './terminal-ui.js';

async function main() {
  const { values } = parseArgs({ options: {
    prompt: { type: 'string' },
    workspace: { type: 'string' },
    session: { type: 'string' },
    knowledge: { type: 'string' },
    'mcp-demo': { type: 'boolean' },
    'mcp-config': { type: 'string' },
    'no-menu': { type: 'boolean' },
    yes: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } });
  const help = '用法：npm start -- [--prompt "任务"] [--workspace 路径] [--session ID] [--yes]\n交互界面：↑↓ 选择，Enter 确认；--no-menu 使用传统输入模式\n资料范围：--knowledge 路径（默认工作目录）\nMCP：--mcp-demo 或 --mcp-config 配置文件路径\n交互命令：/menu /help /tools /new /sessions /exit';
  if (values.help) { console.log(help); return; }
  const workspace = await realpath(path.resolve(values.workspace ?? process.cwd()));
  let provider;
  const store = createSessionStore(workspace);
  let id = values.session ?? store.newId();
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const ui = createTerminalUI();
  let controller = new AbortController();
  let mcp, agent;
  const cancel = () => {
    if (controller) { controller.abort(); console.log('\n正在取消当前任务…'); }
    else ui.close();
  };
  process.on('SIGINT', cancel);
  const approve = async ({ preview, signal }) => {
    console.log(`\n${preview}`);
    if (values.yes) return true;
    if (!terminal) { console.log('非交互模式未授权，操作已拒绝。'); return false; }
    if (values['no-menu']) return /^(y|yes)$/i.test((await ui.question('执行？[y/N] ', { signal })).trim());
    try {
      // 默认落在“不执行”，直接按回车不会意外授权。
      return await ui.select('是否执行上面的操作？', [
        { label: '不执行', value: false }, { label: '执行', value: true },
      ], { initialValue: false, signal }) === true;
    } catch (error) {
      if (error instanceof MenuCancelled) controller?.abort();
      throw error;
    }
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
  const chooseDirectory = async () => {
    const use = Symbol('use'), parent = Symbol('parent');
    let directory = '.';
    while (true) {
      const entries = await readdir(await safePath(workspace, directory), { withFileTypes: true });
      const directories = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()
        && !entry.name.startsWith('.') && !['node_modules', 'vendor', 'dist', 'build', 'target', 'coverage', '__pycache__', 'venv'].includes(entry.name));
      directories.sort((a, b) => a.name.localeCompare(b.name));
      const options = [
        { label: `使用当前目录：${directory}`, value: use },
        ...(directory !== '.' ? [{ label: '返回上一级', value: parent }] : []),
        ...directories.map(entry => ({ label: `进入 ${entry.name}/`, value: path.join(directory, entry.name) })),
      ];
      const selected = await ui.select('选择检索资料的目录', options);
      if (selected === null) return null;
      if (selected === use) return directory;
      directory = selected === parent ? path.dirname(directory) : selected;
    }
  };
  const chooseSession = async () => {
    const sessions = await store.list();
    if (!sessions.length) { console.log('暂无历史会话。'); return null; }
    const options = [];
    for (const sessionId of sessions) {
      let summary = '';
      try { summary = (await store.load(sessionId)).find(message => message.role === 'user')?.content?.slice(0, 30) ?? '空会话'; }
      catch { summary = '无法读取此会话'; }
      options.push({ label: `${summary} (${sessionId.slice(0, 8)}${sessionId === id ? '，当前' : ''})`, value: sessionId });
    }
    return ui.select('选择要恢复的会话', options);
  };
  const examples = [
    { label: '了解这个项目怎么运行（查资料）', value: '请先检索本地资料，解释这个项目的工具调用循环，并引用实际文件和行号。' },
    { label: '了解 RAG 是否需要嵌入模型（查资料）', value: '请先检索资料，解释本项目的 RAG 是否调用嵌入模型，引用实际资料来源。' },
    { label: '列出工作目录（本地工具）', value: '请调用目录工具列出当前工作目录。' },
  ];
  try {
    if (terminal && values.prompt === undefined && !values['no-menu']
      && !values['mcp-demo'] && !values['mcp-config'] && !values.knowledge && !values.session) {
      const mode = await ui.select('Navi-agent：选择启动方式', [
        { label: '开始 Agent（本地工具 + 资料检索）', value: 'agent' },
        { label: '启用 MCP 示例（时间 + 计算）', value: 'mcp' },
        { label: '资料问答（选择资料目录）', value: 'knowledge' },
        { label: '恢复历史会话', value: 'session' },
        { label: '退出', value: 'exit' },
      ], { signal: controller.signal });
      if (mode === null || mode === 'exit') return;
      if (mode === 'mcp') values['mcp-demo'] = true;
      if (mode === 'knowledge') { const directory = await chooseDirectory(); if (directory === null) return; values.knowledge = directory; }
      if (mode === 'session') { const sessionId = await chooseSession(); if (sessionId === null) return; values.session = sessionId; id = sessionId; }
    }
    provider = createDeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY, baseUrl: process.env.DEEPSEEK_BASE_URL, model: process.env.DEEPSEEK_MODEL });
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
    let showMenu = !values['no-menu'];
    while (!ui.closed) {
      let input;
      if (showMenu) {
        const action = await ui.select('接下来做什么？', [
          { label: '输入任务或问题', value: 'ask' },
          { label: '选择一个示例任务', value: 'example' },
          { label: '查看可用工具', value: '/tools' },
          { label: '选择资料目录', value: 'knowledge' },
          { label: '恢复历史会话', value: 'restore' },
          { label: '新建会话', value: '/new' },
          { label: '帮助', value: '/help' },
          { label: '退出', value: '/exit' },
        ]);
        showMenu = !values['no-menu'];
        if (action === null || action === '/exit') break;
        if (action === 'knowledge') {
          const directory = await chooseDirectory();
          if (directory !== null) {
            values.knowledge = directory;
            const index = tools.findIndex(tool => tool.name === 'knowledge_search');
            tools[index] = { ...createKnowledgeTool(workspace, { root: directory }), source: '本地资料/RAG' };
            agent = makeAgent(agent.messages);
            console.log(`资料范围已切换：${directory}`);
          }
          continue;
        }
        if (action === 'restore') {
          const sessionId = await chooseSession();
          if (sessionId !== null) {
            const messages = await store.load(sessionId);
            await store.save(id, agent.messages);
            id = sessionId; agent = makeAgent(messages);
            console.log(`已恢复会话：${id}`);
          }
          continue;
        }
        if (action === 'example') {
          const choices = [...examples];
          if (values['mcp-demo']) choices.push({ label: 'MCP 计算 12 × 8', value: '请调用 mcp__demo__calculate 计算 12 乘以 8。' });
          input = await ui.select('选择示例任务', choices);
          if (input === null) continue;
          console.log(`你> ${input}`);
        } else input = action === 'ask' ? (await ui.question('你> ')).trim() : action;
      } else input = (await ui.question('你> ')).trim();
      if (!input) continue;
      if (input === '/menu') { showMenu = true; continue; }
      if (input === '/exit') break;
      if (input === '/help') { console.log(help); continue; }
      if (input === '/tools') { console.log(tools.map(tool => `${tool.name} [${tool.source}]\n  ${tool.description}`).join('\n')); continue; }
      if (input === '/sessions') { console.log((await store.list()).join('\n') || '暂无会话'); continue; }
      if (input === '/new') { await store.save(id, agent.messages); id = store.newId(); agent = makeAgent(); console.log(`新会话：${id}`); continue; }
      await run(input);
    }
  } catch (error) {
    if (!(error instanceof MenuCancelled) && error.name !== 'AbortError') throw error;
  } finally {
    // 即使保存会话失败，也关闭 MCP 子进程和输入界面。
    try { if (agent) await store.save(id, agent.messages); }
    finally { ui.close(); process.removeListener('SIGINT', cancel); await mcp?.close(); }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
