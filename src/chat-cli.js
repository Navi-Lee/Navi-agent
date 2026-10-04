import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { createDeepSeekProvider } from './provider.js';
import { createChatbot } from './chatbot.js';

async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, prompt: { type: 'string' } } });
  const help = '纯聊天模式：npm run chat\n命令：/new 清空对话，/help 帮助，/exit 退出\n单次回答：npm run chat -- --prompt "你好"';
  if (values.help) { console.log(help); return; }
  const bot = createChatbot({
    provider: createDeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY, baseUrl: process.env.DEEPSEEK_BASE_URL, model: process.env.DEEPSEEK_MODEL }),
    onTrim: () => console.log('[上下文] 已移除最早的完整对话'),
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let controller;
  const cancel = () => {
    if (controller) { controller.abort(); console.log('\n正在取消…'); }
    else rl.close();
  };
  process.on('SIGINT', cancel); rl.on('SIGINT', cancel);
  const ask = async input => {
    controller = new AbortController();
    try {
      const { content } = await bot.chat(input, { signal: controller.signal });
      console.log(`\n助手> ${content}\n`);
      return true;
    } catch (error) {
      console.error(controller.signal.aborted ? '已取消，可以继续输入。' : `请求失败：${error.message}`);
      return false;
    } finally { controller = undefined; }
  };
  try {
    if (values.prompt !== undefined) { if (!await ask(values.prompt)) process.exitCode = 1; return; }
    if (!process.stdin.isTTY) throw new Error('交互聊天请在终端运行；非交互环境请使用 --prompt');
    console.log(help);
    while (!rl.closed) {
      let input;
      try { input = (await rl.question('你> ')).trim(); } catch (error) { if (rl.closed) break; throw error; }
      if (!input) continue;
      if (input === '/exit') break;
      if (input === '/help') { console.log(help); continue; }
      if (input === '/new') { bot.reset(); console.log('对话已清空。'); continue; }
      await ask(input);
    }
  } finally { rl.close(); process.removeListener('SIGINT', cancel); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
