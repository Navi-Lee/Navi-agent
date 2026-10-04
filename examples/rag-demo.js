import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createKnowledgeTool } from '../src/knowledge.js';

// 直接执行检索工具，先看清“翻资料”这一步；本脚本不调用模型，不需要 API 密钥。
async function main() {
  const { values } = parseArgs({ options: {
    query: { type: 'string', default: 'createAgent' },
    knowledge: { type: 'string', default: 'src' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('用法：npm run demo:rag -- [--query "检索词"] [--knowledge 资料目录] [--help]\n默认检索词：createAgent；默认资料目录：src；资料目录必须位于项目根目录内。');
    return;
  }
  // 以项目目录为边界，因此从其他目录启动本脚本也不会意外检索其他文件。
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = await createKnowledgeTool(workspace, { root: values.knowledge }).execute({ query: values.query });
  console.log(`检索词：${values.query}`);
  console.log(`资料目录：${result.root}`);
  console.log(`读取 ${result.scannedFiles} 个文本文件；找到 ${result.totalMatches} 个相关片段，展示最多 5 个。`);
  for (const match of result.matches) {
    console.log(`\n来源：${match.path}:${match.startLine}-${match.endLine}`);
    console.log(`命中词：${match.matchedTerms.join('、')}；出现次数：${match.occurrences}`);
    console.log(match.text);
  }
  if (!result.matches.length) console.log('没有找到匹配片段。试试代码名 createAgent 或关键词 messages。');
  if (result.limited) console.log('本次扫描达到读取上限，可用更小的资料目录重新检索。');
}

main().catch(error => { console.error(`检索演示失败：${error.message}`); process.exitCode = 1; });
