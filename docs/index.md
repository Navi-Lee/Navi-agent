# 项目导读：这个 Agent 做了什么，从哪里开始看

这个项目把 DeepSeek 接到一个本地运行程序上，让模型能提出工具请求，由程序真正查资料、操作文件、调用外部工具，再把结果交回模型。你可以通过命令行和它聊天、给它任务，并看见每次工具调用的过程。

**先读完这份导读，就能知道项目怎么运转。** 每个主题后面的“看原文”会带你到详细文档的对应位置；源码地图还提供直接打开代码的链接。

三份原文各有用途：[README](../README.md) 查启动命令，[学习文档](learning-guide.md) 看解释和练习，[架构文档](architecture.md) 查接口与扩展约定。

**使用时也不用背命令。** 运行 `npm start`，方向键选启动方式，回车确认；接着可以选示例任务、工具列表、资料目录或历史会话。只有问题内容需要自己输入；写文件等操作也用菜单确认，默认不执行。→ [看菜单操作与代码解释](learning-guide.md#guide-cli)

## 1. 现在能做什么

| 你想做的事 | 程序怎样完成 | 继续看 |
| --- | --- | --- |
| 普通聊天 | 每轮问一次 DeepSeek，不执行工具，对话只留在本次运行内存中 | [看聊天入口原文](learning-guide.md#guide-chatbot) |
| 让助手查文件、改文件或执行命令 | 模型提出工具请求，程序校验；写入和命令默认经过确认 | [看本地工具原文](learning-guide.md#guide-local-tools) |
| 根据自己的文档或项目代码回答 | 用关键词找相关片段，把片段发给模型，要求回答带出处 | [看 RAG 原文](learning-guide.md#guide-rag) |
| 调用另一个程序提供的工具 | 通过 MCP 接入本地服务；示例能获取时间和做四则运算 | [看 MCP 原文](learning-guide.md#guide-mcp) |
| 下次继续同一个会话 | 把消息和工具结果存到工作目录的 `.agent/sessions`，用会话 ID 恢复 | [看会话保存原文](learning-guide.md#guide-session) |

先体验工具本身，可以不填模型密钥；让 DeepSeek 参与回答时才需要配置密钥。→ [看无需密钥的演示](../README.md#readme-demo) · [看模型配置和启动方式](../README.md#readme-start)

## 2. 一次任务是怎样完成的

假设你输入：“根据项目资料解释工具循环，再用 MCP 计算 12 乘以 8。”模型可能先查资料、再计算，还可能补读源码。顺序和查询词由模型选择，程序负责执行与记录。→ [看一次任务的完整过程](learning-guide.md#guide-task-flow)

1. **接收问题，准备对话。** 程序把你的话加入消息列表，连同已有历史一起提供给模型。→ [看消息列表原文](learning-guide.md#guide-messages)
2. **告诉模型有哪些工具。** 发过去的是工具名称、用途和参数说明，真正的函数留在本机。→ [看工具说明原文](learning-guide.md#guide-tool-definitions)
3. **模型提出下一步。** 例如请求 `knowledge_search`，参数是一个检索词；这时文件还没有被读取。→ [看工具请求长什么样](learning-guide.md#guide-tool-calls)
4. **程序真正动手。** 找到工具、检查参数，必要时询问你是否同意，然后执行。→ [看校验和执行原文](learning-guide.md#guide-tool-execution)
5. **带着对应号码回传结果。** 每个结果都对应原来的那次工具请求，模型才能知道哪一步成功或失败。→ [看工具结果与对应号码](learning-guide.md#guide-tool-results)
6. **再次问模型。** 它可以继续请求工具，也可以给出最终回答；程序设有调用次数上限。→ [看循环如何继续和停止](learning-guide.md#guide-next-step)

这里最值得观察的是：**一轮用户提问，可能包含多次模型请求；一次模型请求，又可能提出多个工具调用。** 它们是不同的计数。→ [看次数与上下文预算](learning-guide.md#guide-budgets)

## 3. 必要概念，用白话理解

### 模型和 harness 各负责什么

模型负责阅读已收到的消息、选择下一步和组织回答。Harness 是围着模型写的程序：提供工具、校验参数、处理授权、管理历史、保存状态、取消任务。你已经知道“agent = model + harness”，这里要进一步观察的是哪些判断由模型做，哪些规则由代码强制执行。→ [看角色分工](learning-guide.md#guide-roles) · [比较聊天与 agent](learning-guide.md#guide-chat-agent)

### RAG：回答前先翻资料

资料太长时，程序先选出与问题相关的小片段，再让模型根据这些片段回答。本项目每次检索都读当前文件，所以你修改资料后，下次检索就能读到新内容。→ [看 RAG 流程](learning-guide.md#guide-rag)

为了只发送相关内容，文字会切成约 1000 字符的小片段，保留少量重叠，以及原文件路径和行号。→ [看为什么切片段、为什么保留行号](learning-guide.md#guide-rag-chunks)

### Embedding：本项目没有额外调用它

当前检索用普通代码分词，再按匹配词的数量和次数排序，**不调用嵌入模型，也没有向量数据库**。Agent 会请求 DeepSeek 来选择下一步和生成回答，检索工具本身不请求模型；单独的检索演示完全不调用模型。→ [看实际检索规则](learning-guide.md#guide-rag-ranking)

嵌入模型是另一种检索方式：把文字转换成一串数字，再比较意思的相近程度。“车辆”可能因此匹配到“汽车”。RAG 只要求先检索再生成，不要求检索必须使用向量。→ [看关键词检索与嵌入模型的区别](learning-guide.md#guide-embedding)

### MCP：统一接入另一个程序的工具

MCP 规定了连接、发现工具、请求调用和返回结果的交流方式。本项目的客户端在 agent 里，示例服务在另一个本地进程里；并不需要一台远程服务器。→ [看谁是客户端和服务端](learning-guide.md#guide-mcp-processes)

适配代码把 MCP 工具转成普通工具的形状，所以 RAG、本地工具、MCP 都能进入同一个 agent 循环。→ [看 MCP 工具怎么接进来](learning-guide.md#guide-mcp-adapter) · [查统一工具接口](architecture.md#architecture-interfaces)

### 上下文、会话、资料：三种“记住”

**上下文**是这次请求发给模型的消息；**会话**是磁盘里保存的对话记录；**资料**是等待检索的本地文档和源码。模型只有收到内容后才能用它回答。会话保存和 RAG 都不会修改模型参数，也没有实现跨会话自动提炼的长期记忆。→ [看三种信息的区别](learning-guide.md#guide-session) · [看 RAG 与训练、记忆的区别](learning-guide.md#guide-rag-memory)

### Token：观察模型请求用量

Token 是模型处理文字的计量单位，不等于字符数。日志会显示本次任务累计的输入、输出用量；项目对上下文大小的限制则使用字符预算，二者不要混为一谈。→ [看模型接口和用量](learning-guide.md#guide-provider) · [看预算设计](learning-guide.md#guide-budgets)

## 4. 真正让这个 agent 可用的几件事

| 容易忽略的问题 | 本项目怎么处理，为什么要这样 | 看原文 |
| --- | --- | --- |
| 模型传了错参数怎么办 | 参数说明给模型看，`validate` 才在执行前检查；失败作为工具结果回传 | [参数校验](learning-guide.md#guide-validation) |
| 模型说“用户同意了”就能执行吗 | 写文件、命令和第三方 MCP 工具默认要经过程序的确认回调；`--yes` 明确跳过确认 | [授权与数据边界](../README.md#readme-data) |
| 对话太长、模型一直请求工具怎么办 | 超过预算时移除最早完整轮次，当前轮过大则停止；默认最多请求模型 20 次 | [循环与上下文预算](learning-guide.md#guide-budgets) |
| 执行一半取消，消息会乱吗 | 为本次响应的每个工具请求补齐结果，包括未执行的取消结果，便于恢复 | [失败、取消与状态](learning-guide.md#guide-failure-state) |
| MCP 服务启动失败或一直不返回怎么办 | 连接和调用有超时，退出或部分启动失败时关闭服务进程 | [外部工具的生命周期](learning-guide.md#guide-process-cleanup) |
| 有出处，回答就一定正确吗 | 工具可以真的找到资料，模型仍可能误读；要把检索证据与最终答案分开核对 | [检索证据与回答准确度](learning-guide.md#guide-evidence) |

这些都有能亲手观察的实验。→ [看五个工程设计实验](learning-guide.md#guide-reliability)

## 5. 想看代码，从这里找到负责的文件

建议先看入口怎么装配，再看主循环，最后按兴趣打开工具实现。暂时不熟悉 JavaScript 时，可以对照小字典阅读。→ [看完整源码地图](learning-guide.md#guide-code-map) · [看 JavaScript 小字典](learning-guide.md#guide-javascript)

| 你想知道什么 | 负责的代码 | 对应解释 |
| --- | --- | --- |
| 启动参数、用户输入、确认和日志怎么接起来 | [cli.js](../src/cli.js) | [入口装配](learning-guide.md#guide-cli) |
| 方向键菜单和文字输入怎样交替工作 | [terminal-ui.js](../src/terminal-ui.js) | [菜单解释](learning-guide.md#guide-cli) |
| 模型和工具怎么不断循环 | [agent.js](../src/agent.js) | [主循环](learning-guide.md#guide-agent) |
| 怎么把消息发给 DeepSeek、处理超时和重试 | [provider.js](../src/provider.js) | [模型接入](learning-guide.md#guide-provider) |
| 本地文件、命令、网页工具怎么执行 | [tools.js](../src/tools.js) | [本地工具](learning-guide.md#guide-local-tools) |
| 怎么分词、切片段、打分和返回出处 | [knowledge.js](../src/knowledge.js) | [RAG 检索](learning-guide.md#guide-rag-ranking) |
| 怎么发现和调用另一个进程的工具 | [mcp.js](../src/mcp.js) | [MCP 适配](learning-guide.md#guide-mcp-adapter) |
| MCP 配置怎样读取，相对路径从哪里算 | [mcp-config.js](../src/mcp-config.js) | [服务配置](learning-guide.md#guide-mcp-config) |
| 会话保存在哪，下次怎么恢复 | [session.js](../src/session.js) | [保存与恢复](learning-guide.md#guide-session) |
| 没有工具的聊天入口是什么样 | [chat-cli.js](../src/chat-cli.js)、[chatbot.js](../src/chatbot.js) | [纯聊天](learning-guide.md#guide-chatbot) |
| MCP 工具在服务端到底执行什么 | [mcp-server.js](../examples/mcp-server.js) | [服务端与示例工具](learning-guide.md#guide-mcp-processes) |

需要扩展自己的代码时，再查函数的参数、返回值和回调约定。→ [看架构接口](architecture.md#architecture-interfaces) · [看添加工具的约定](architecture.md#architecture-add-tool)

## 6. 先跑哪条命令，看到什么才算对

在项目根目录运行，使用 Node.js 24 或更新版本；首次安装依赖用 `npm ci`。已有 `.env` 就保留，真实模型配置步骤去 README 查。→ [看启动原文](../README.md#readme-start)

| 目的 | 命令 | 应该观察什么 | 详细步骤 |
| --- | --- | --- | --- |
| 只看检索，不请求模型 | `npm run demo:rag -- --knowledge docs --query "工具"` | 文本片段、命中词、文件路径和行号 | [演示说明](learning-guide.md#guide-start) |
| 只看 MCP，不请求模型 | `npm run demo:mcp` | 发现两个工具，显示时间和 `2 + 3 = 5`，随后退出 | [演示说明](../README.md#readme-demo) |
| 让真实模型使用资料和 MCP | `npm start -- --knowledge docs --mcp-demo` | 输入问题后，观察工具日志和最终回答；`/tools` 查看工具来源 | [交互步骤](learning-guide.md#guide-start) |
| 只进行普通聊天 | `npm run chat` | 模型回答，没有工具调用 | [聊天入口](../README.md#readme-chat) |
| 检查程序行为 | `npm test` | 本地测试结果，无需真实模型密钥 | [测试说明](learning-guide.md#guide-tests) |

演示脚本直接调用工具，agent 模式让模型选择工具。前者通过能证明工具工作，后者还要观察实际工具选择和回答。→ [看测试分别能证明什么](learning-guide.md#guide-tests)

## 7. 按你想学的东西挑练习

| 想弄懂的能力 | 做什么 | 去原文动手 |
| --- | --- | --- |
| 我怎么给 agent 增加能力 | 新增统计字符的工具，用模拟模型走完整调用链，再尝试错误参数 | [练习一：添加本地工具](learning-guide.md#guide-exercise-tool) |
| 自己的资料怎么进入回答 | 加一份小店 Markdown，检查检索、行号、修改后的新结果 | [练习二：加入自己的资料](learning-guide.md#guide-exercise-rag) |
| 外部程序的工具怎么接进来 | 给 MCP 服务加一个问候工具，再从客户端发现和调用 | [练习三：增加 MCP 工具](learning-guide.md#guide-exercise-mcp) |
| 失败、取消、预算这些代码为什么存在 | 先预测结果，再运行针对性的测试，核对状态变化 | [五个设计实验](learning-guide.md#guide-reliability) |

## 8. 已经验证了什么，还有什么要区分

本地自动测试、无模型演示和真实 DeepSeek 只读链路都已验证。真实任务中模型检索源码，调用 MCP 得到 `96`，还补搜、补读了代码。**但它把主循环的一处行号引用错了**；这给了你一个实际例子，说明程序正确执行和模型正确解释需要分别检查。→ [看真实验收记录](learning-guide.md#guide-verification) · [看测试范围](architecture.md#architecture-verification)

当前检索是关键词方式，对近义词和换一种说法可能匹配不到；本版未接入嵌入模型、向量数据库或 PDF/Word 解析。→ [看检索方式](learning-guide.md#guide-embedding) · [看资料范围](learning-guide.md#guide-rag-boundaries)

当前 MCP 只接本地 stdio 工具，没有远程 HTTP 接入；会话也没有实现独立长期记忆。→ [看 MCP 配置](learning-guide.md#guide-mcp-config) · [看会话与记忆](learning-guide.md#guide-rag-memory)

遇到启动失败、无匹配、参数错误、调用被拒绝或超时，先找到失败发生在哪一层，再处理。→ [打开排错表](learning-guide.md#guide-troubleshooting)

## 9. 推荐怎么读

第一次先读本导读，接着[运行两个无密钥演示](../README.md#readme-demo)，再看[一次任务的完整过程](learning-guide.md#guide-task-flow)。你会把日志里的工具名和程序步骤对应起来。

第二次按兴趣读 [RAG](learning-guide.md#guide-rag) 或 [MCP](learning-guide.md#guide-mcp)，然后做[三个练习](learning-guide.md#guide-exercises)。你会知道新增能力到底要改什么、注册在哪。

第三次看[五个设计实验](learning-guide.md#guide-reliability)，再查[架构与接口](architecture.md#architecture-interfaces)。你会开始理解：让模型能行动之后，还要有人负责状态、边界、预算和收尾。
