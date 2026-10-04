# 架构与扩展

[返回项目导读与索引](index.md)

<a id="architecture-loop"></a>

## 核心循环

```text
用户输入 → 加入历史 → 裁剪旧轮次 → 请求模型
                                ↓
                    最终回答 ← 没有工具调用
                                ↓ 有工具调用
                    校验参数 → 展示变更并授权（按需）
                                ↓
                    顺序执行 → 加入 tool 结果 → 保存 → 再请求模型
```

模型只产生调用建议，工具真正由 harness 执行。一次模型响应中的所有调用按顺序处理；工具结果与原始 `tool_call_id` 对应。即使取消任务，也补齐本次响应中尚未执行工具的取消结果，避免恢复后出现悬空调用。

<a id="architecture-interfaces"></a>

## 模块职责与接口

- `src/provider.js`：DeepSeek HTTP 接入。`complete(messages, tools, { signal })` 返回 `{ message, usage }`。仅重试网络错误、429、5xx，默认 2 次重试、指数退避；用户取消不重试。
- `src/agent.js`：`createAgent(options)` 返回 `{ messages, run(input, { signal }) }`。结果为 `{ content, usage }`；同一实例禁止并发 run。达到步数上限、取消或 provider 失败时抛出错误并保存已有状态。
- `src/tools.js`：工具注册、路径校验、进程执行、网页获取。`createTools(workspace)` 的 workspace 应为绝对真实目录。
- `src/session.js`：`createSessionStore(workspace)` 提供 `newId / save / load / list`。
- `src/cli.js`：解析参数、用户输入、确认和日志。不把确认逻辑写进模型。
- `src/knowledge.js`：`createKnowledgeTool(workspace, { root = '.' })` 返回 `knowledge_search` 工具；按需检索文本并返回来源位置。
- `src/mcp.js`：`connectMcpServers(servers, { signal, timeoutMs = 30000 })` 返回 `{ tools, close }`，将 MCP 工具适配为相同的工具接口。
- `src/mcp-config.js`：`loadMcpConfig(workspace, configPath)` 校验显式指定的本地配置，服务工作目录使用配置文件父目录。

`createAgent` 选项默认值：`maxSteps=20`、`maxContextChars=100000`、`maxToolOutput=12000`、`approve=拒绝`。`onEvent(event)` 接收 `tool_start`、`tool_end`、`trim`、`usage`；`save(messages)` 在工具链完成和任务结束时调用。调用方应保持回调可靠，存储失败会作为运行错误报告。

每个工具提供 `name`、`description`、`parameters`（JSON Schema）、`validate(args)`、`execute(args, { signal })`。可选 `preview(args, { signal })`：有 preview 就必须通过 approve，再执行。validate 失败通过工具结果回传，而不是直接终止任务。使用非 beta 接口，参数由本地校验，不依赖 API strict 模式。

<a id="architecture-add-tool"></a>

## 添加工具

```js
const currentTime = {
  name: 'current_time',
  description: '返回当前 UTC 时间',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  validate(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) {
      throw new Error('此工具不接受参数');
    }
  },
  async execute(_args, { signal }) {
    signal?.throwIfAborted();
    return { utc: new Date().toISOString() };
  },
};
// 将其与 createTools(workspace) 的结果一起传入 createAgent({ tools: [...] })。
```

有副作用的工具应提供 preview，展示所有将要执行的操作。实现 execute 时遵守 signal，设置超时，限制结果大小；返回可 JSON 序列化的数据。不要把工具数据当作高优先级指令。文件或网页中的文字不能绕过 harness 的确认流程。

<a id="architecture-integration"></a>

## RAG 与 MCP 接入

CLI 将本地工具、`knowledge_search` 和可选 MCP 工具合并后传给 `createAgent`。核心循环不区分它们；`source` 只供 `/tools` 展示。检索工具存在时，每次模型请求临时给第一条 system 消息补充检索与引用要求，恢复旧会话也适用；保存的 system 原文保留。这部分文字同样计入上下文预算。

检索参数为 `{ query: string }`，结果包含 `matches`、`limited`、`scannedFiles`、`scannedBytes`、`root`。片段包含 `path/startLine/endLine/text/matchedTerms/occurrences`。路径相对 workspace、行号从 1 开始。每次重新读取符合条件的文件，在内存中切分和排名；没有持久化索引。原文件仍是资料来源，已有会话中的旧片段不会随文件自动改写。

MCP 客户端负责 `connect → listTools → callTool → close`，官方 SDK 负责协议与 stdio。工具名称加服务器前缀，原 `inputSchema` 作为模型参数说明；本地及服务端校验调用参数。结果保留文本和结构化内容，非文本块仅返回摘要，服务 `isError` 和协议错误均回传失败。启动或调用受超时、取消约束，部分启动失败也关闭已连接服务。

内置示例的两个明确只读工具允许免确认；其他 MCP 工具一律提供 preview，不信任服务自己的只读注解。配置只接受 `{ servers: [{ name, command, args }] }`，不能配置免确认。退出时在 finally 中关闭连接，包括保存会话失败的场景。MCP 程序不是文件工具沙箱中的进程，连接配置即表示用户选择启动该程序。

<a id="architecture-state"></a>

## 状态与故障

历史保留 system、user、assistant 和 tool 消息；API Key 只用于请求头。恢复使用原会话 system prompt，运行配置与工具来自当前程序。会话 JSON 是可信的本地状态文件，不应加载陌生人提供的会话。

裁剪以 user 消息为轮次边界，不拆开 assistant/tool 对；始终保留 system 与当前轮。token 用量只统计该 run 的成功响应，失败请求是否计费以服务端为准。完整历史可由调用方另外接入审计存储。

命令失败返回 exitCode，命令超时返回 timedOut，供模型判断；授权拒绝和工具异常返回 `{ ok: false, error }`。错误不会被包装为成功。进程树停止使用 Windows taskkill 或 Unix 进程组，特殊的脱离进程不属于严格隔离保证。

<a id="architecture-verification"></a>

## 验证

`npm test` 覆盖模型循环、顺序回传、参数错误、授权拒绝、取消、上限、裁剪、文件边界、符号链接、搜索、会话恢复、命令超时和输出截断、网络重试及请求超时，以及本地检索与 MCP 链路。CLI 集成测试启动本地模拟 HTTP 服务，验证读取、修改提议、授权与最终结果，不使用真实密钥。MCP 测试使用实际子进程服务；演示脚本绕开模型，便于独立观察工具行为。

真实接入验收：配置有效密钥后先运行只读任务，再在交互模式要求创建一个测试文本文件，检查确认展示、实际内容和最终回答。缺少密钥时不能声称真实 DeepSeek 已验证。

2026-10-04 经用户授权完成真实模型只读验收：`knowledge_search`、MCP 计算、`search_text`、`read_file` 均成功，计算结果为 96，最终回答已返回；主循环引用行号有误，已在学习文档第 8.4 节记录。写入授权通过模拟 API 的 CLI 测试验证，本次真实验收未执行写入或命令。接入链路验证与回答事实准确度分开报告。
