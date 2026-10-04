# 简易 Node.js Agent Harness

一个用于学习 agent 基础的命令行助手：接入 DeepSeek，调用本地工具，检索自己的资料，连接 MCP 服务，并保存会话。原生 JavaScript + Node.js 24；MCP 使用官方 SDK，没有 agent 框架。

**Harness** 是模型周围的运行程序：负责工具、授权、上下文、状态和错误处理。**Agent** 是模型与 harness 组合后，通过循环完成任务的系统。这不是训练模型，而是让已有模型能够行动。

**推荐先读 [项目导读与索引](docs/index.md)**：用白话了解项目做了什么，并按问题跳到对应原文。接着读 [中文学习文档](docs/learning-guide.md)，按“聊天 → 工具循环 → RAG → MCP”的顺序看代码与练习。接口细节见 [架构文档](docs/architecture.md)。

<a id="readme-demo"></a>

## 先体验，不用模型密钥

```powershell
npm ci
npm run demo:rag -- --query "工具"
npm run demo:mcp
```

第一个演示默认搜索项目的 `src`，输出片段和行号；可加 `--knowledge docs` 搜索学习文档。第二个启动本地 MCP 服务，调用时间和计算工具后退出。这两个演示不请求 DeepSeek，也不会生成模型回答。

<a id="readme-start"></a>

## 快速开始

在本目录用 PowerShell 执行：

```powershell
# 首次配置时执行；如果已有 .env，保留它
Copy-Item .env.example .env
# 编辑 .env，填入你的 DeepSeek API Key
npm start
```

Node.js 必须为 24 或以上。首次运行先执行 `npm ci`，安装锁定版本的 MCP SDK 和参数校验依赖。

`.env` 配置：

```dotenv
DEEPSEEK_API_KEY=你的密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
```

模型名可替换成你账户可用的、支持 Chat Completions 与工具调用的模型。程序发送 `thinking: { type: "disabled" }`，采用非流式响应。参考 [DeepSeek 工具调用文档](https://api-docs.deepseek.com/guides/tool_calls/) 和 [Chat Completions 接口](https://api-docs.deepseek.com/api/create-chat-completion/)。

```powershell
# 交互模式，指定已有的工作目录
npm start -- --workspace "E:\my-project"

# 单次任务，默认拒绝写入和命令执行
npm start -- --prompt "列出当前目录，并总结 README"

# 显式授权自动写入及命令执行
npm start -- --prompt "读取 notes.txt，修正错别字并保存" --yes

# 恢复会话，ID 会在启动时显示
npm start -- --session "会话ID"

# 只检索自己的资料目录（必须在工作目录内）
npm start -- --knowledge docs --prompt "根据资料，工具授权是怎么工作的？请引用来源"

# 开启内置 MCP 服务
npm start -- --mcp-demo --prompt "请用 MCP 计算 12 乘以 8"

# 接入配置指定的 MCP 服务；第三方调用默认需要确认
npm start -- --mcp-config mcp.config.example.json
```

从其他目录直接启动时可用 `node --env-file=E:\agent\.env E:\agent\src\cli.js --workspace 路径`。`npm start` 从项目目录加载 `.env`。

## 能做什么

<a id="readme-chat"></a>

### 只想聊天

同一个项目附带独立的纯聊天入口，复用 `.env` 中的 DeepSeek 配置：

```powershell
npm run chat
```

输入消息后回车即可多轮聊天。`/new` 清空对话，`/help` 显示帮助，`/exit` 退出；请求过程中 Ctrl+C 取消，空闲时 Ctrl+C 退出。对话只保存在本次运行内存中，退出后不保留。它每轮只请求一次模型，不加载 agent 循环，也没有任何工具或文件操作。

单次回答：`npm run chat -- --prompt "解释一下 JavaScript 的 Promise"`。

下面的工具和会话保存功能属于 `npm start` 启动的 agent 模式。

| 工具 | 能力 | 授权 |
| --- | --- | --- |
| `list_directory` | 列出目录，最多 500 项 | 自动 |
| `read_file` | 读取 UTF-8 文本，最多 100KB | 自动 |
| `search_text` | 递归搜索文字，返回行号 | 自动 |
| `write_file` | 创建或覆盖文件，展示原内容和新内容 | 逐次确认 |
| `run_command` | Windows PowerShell / Unix shell 命令 | 逐次确认 |
| `fetch_page` | 获取公开网页的原始文本或 HTML | 自动 |
| `knowledge_search` | 检索本地资料，返回最多 5 个相关片段及来源行号 | 自动 |
| `mcp__demo__current_time` | MCP 示例：获取 UTC 和北京时间 | 自动，仅 `--mcp-demo` |
| `mcp__demo__calculate` | MCP 示例：加减乘除 | 自动，仅 `--mcp-demo` |

直接运行 `npm start`，用 **↑↓ 选择、Enter 确认** 启动方式；进入后可选择输入任务、示例任务、查看工具、选择资料目录、恢复会话或退出。目录逐级浏览，会话显示首个问题，不必手打路径或会话 ID。Esc 返回（主菜单退出），当前任务运行时 Ctrl+C 取消；空闲时 Ctrl+C 退出。

支持多轮对话、连续工具调用、失败反馈和 token 用量显示。交互命令仍可输入：`/menu`、`/help`、`/tools`、`/new`、`/sessions`、`/exit`。选择“输入任务或问题”后输入文字；`/tools` 显示工具及来源。`npm start -- --no-menu` 保留传统逐行输入；`--prompt` 的单次任务方式不变。纯聊天入口 `npm run chat` 仍使用逐行输入。

## 本地 RAG 与 MCP

**RAG** 在这里就是“先找资料，再把片段交给模型回答”。默认检索工作目录中的 Markdown、文本和常见代码，支持 `--knowledge` 指定子目录。使用关键词相关性排序，不依赖向量数据库或额外账号；近义词不一定能命中，可以换关键词。每次检索都读当前文件，修改资料后无需重建索引。模型按需调用检索工具，调用日志会显示 `knowledge_search`；提示词要求引用来源，但不能保证模型每次都遵循。

**MCP** 是程序间提供工具的标准协议。`--mcp-demo` 使用项目自带服务，工具名如 `mcp__demo__calculate`。接入其他本地服务时，配置格式为：

```json
{ "servers": [{ "name": "example", "command": "node", "args": ["examples/mcp-server.js"] }] }
```

配置文件必须在工作目录内。服务在配置文件所在目录启动，相对参数路径从这里计算；启动命令用 PATH 中的程序名或绝对路径。只加载你明确指定的配置；指定配置会启动其中的程序，工具调用再进入确认流程。服务进程拥有当前用户权限，不受本地文件工具的路径校验约束。外部服务的“只读”标记不会自动免除确认；`--yes` 会跳过确认。示例配置虽启动同一个示例服务，也按第三方配置处理并要求确认。

本版只支持本地 stdio MCP 工具，不支持远程 HTTP、资源或提示词功能。新增服务和检索结果都复用现有 agent 循环。

网页工具不是搜索引擎，也不运行网页 JavaScript。搜索跳过依赖、内部状态、密钥文件、符号链接和大文件，最多扫描 2000 个条目、返回 100 个匹配。工具结果默认截断到约 12000 字符。

<a id="readme-data"></a>

## 授权和数据边界

文件工具检查路径和已有父目录的真实路径，阻止工作目录外的路径及符号链接；禁止访问 `.env`、`.env.*`、`.agent`、`.git`。这是个人本地工具，不适合在敌对多用户环境运行：路径校验和实际读写之间仍存在文件系统竞态。

写入和命令执行先显示预览，再用方向键选择“不执行”或“执行”，默认“不执行”。`--no-menu` 模式下输入 `y` 或 `yes` 确认。非交互 `--prompt` 默认拒绝这些操作；`--yes` 明确跳过确认。**命令执行不是沙箱**：命令拥有当前用户权限，可以访问工作目录以外的文件和网络。默认超时 30 秒，并终止进程树，保留最多 12000 字符输出。

网页工具拒绝本地与私有地址，并逐次校验重定向；DNS 校验后由 fetch 再解析，因此不能当作严格的网络隔离机制。只在可信的本机环境使用。

对话和读取到的文件内容会发送给 DeepSeek。不要让助手读取敏感文件，不要在聊天里粘贴密钥。程序不会把 provider 配置或 API Key 写入会话；用户自己输入的内容会原样保存。

检索额外跳过依赖、构建目录、常见密钥文件和 MCP 配置，单文件最多 100KB、每次最多扫描 2000 条目和读取 2MB 文本。返回 `limited` 表示没有完整检索。自定义敏感文件仍需自己排除，建议用 `--knowledge` 指定专门的资料目录。检索片段和 MCP 文本结果也会进入对话及本地会话记录。

会话保存在工作目录的 `.agent/sessions/<ID>.json`，包括完整消息和工具链，以临时文件加重命名方式保存。上下文超过默认 100000 字符时移除最早完整轮次；当前轮次本身过大则停止。字符数是简单的上下文预算，并非精确 token 计数。裁剪后保存的是裁剪后的历史，不是永久审计日志。

## 作为库使用

```js
import { createAgent } from './src/agent.js';
import { createDeepSeekProvider } from './src/provider.js';
import { createTools } from './src/tools.js';

const agent = createAgent({
  provider: createDeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY }),
  tools: createTools(process.cwd()),
  approve: async ({ name, preview }) => {
    console.log(name, preview);
    return false; // 接入你自己的确认界面
  },
});
const { content, usage } = await agent.run('列出当前目录');
console.log(content, usage);
```

库调用默认不保存会话，也不授权写入；通过 `save` 回调接入存储。完整扩展方式见 [架构文档](docs/architecture.md)。

<a id="readme-tests"></a>

## 测试和排错

```powershell
npm test
npm start -- --help
npm run demo:rag -- --query "createAgent"
npm run demo:mcp
```

测试使用 Node.js 内置测试工具和模拟 API，无需密钥或付费请求。

| 现象 | 处理 |
| --- | --- |
| 提示缺少密钥 | 从示例创建 `.env`，填写 `DEEPSEEK_API_KEY` |
| HTTP 401 | 检查 API Key |
| HTTP 400 / 模型不可用 | 检查模型名和服务是否支持工具调用及 thinking 参数 |
| HTTP 429 / 5xx | 自动有限重试，仍失败时稍后重试 |
| 请求超时 | 默认 60 秒，库中可配置 `timeoutMs` |
| 达到 20 次调用上限 | 将任务拆小；库中可配置 `maxSteps` |
| 非交互操作被拒绝 | 确认任务后显式传 `--yes` |
| 当前上下文过长 | `/new` 新建会话，减少输入和工具内容 |

当前版本不包含网页界面、多 agent、向量数据库、定时任务或独立长期记忆。建议阅读顺序：[项目导读与索引](docs/index.md) → README 启动演示 → [学习文档](docs/learning-guide.md) → [架构文档](docs/architecture.md) → 自己完成三个练习。
