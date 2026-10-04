import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';

const demoFile = fileURLToPath(new URL('../examples/mcp-server.js', import.meta.url));
const demoTools = new Set(['current_time', 'calculate']);
const maxResultChars = 12000;
const comparablePath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

function checkTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('MCP 超时必须是正整数毫秒');
}

function toolName(server, tool) {
  const safe = value => value.replace(/[^a-zA-Z0-9_-]/g, '_');
  const full = `mcp__${safe(server)}__${safe(tool)}`;
  // 模型接口对工具名长度有限制；短名字易读，长名字用摘要保留区别。
  return full.length <= 63 ? full : `${full.slice(0, 54)}_${createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 8)}`;
}

function isTrustedDemo(server, remoteName) {
  // readOnlyHint 是服务端自己的声明，不能把它当作用户授权。
  // 只有本项目明确指定的示例程序和这两个工具可以免确认。
  return Array.isArray(server.trustedReadOnly) && server.trustedReadOnly.includes(remoteName)
    && demoTools.has(remoteName) && server.args.length === 1
    && comparablePath(server.command) === comparablePath(process.execPath)
    && comparablePath(path.resolve(server.cwd ?? process.cwd(), server.args[0])) === comparablePath(demoFile);
}

function readableResult(result) {
  let remaining = maxResultChars, truncated = false;
  const text = value => {
    const input = String(value ?? '');
    const output = input.slice(0, remaining);
    remaining -= output.length;
    truncated ||= input.length > output.length;
    return output;
  };
  const content = (result.content ?? []).slice(0, 64).map(block => {
    if (block.type === 'text') return { type: 'text', text: text(block.text) };
    if (block.type === 'resource' && typeof block.resource?.text === 'string') {
      return { type: 'resource', resource: { uri: block.resource.uri, mimeType: block.resource.mimeType, text: text(block.resource.text) } };
    }
    if (block.type === 'resource_link') return { type: block.type, name: text(block.name), uri: text(block.uri), description: text(block.description) };
    // 这个教学 agent 只把文本送给模型，图片/音频保留类型信息，避免发送大段 base64。
    return { type: block.type, mimeType: block.mimeType ?? block.resource?.mimeType, uri: block.resource?.uri, omitted: true };
  });
  truncated ||= (result.content?.length ?? 0) > content.length;
  const output = { content };
  if (result.structuredContent !== undefined) {
    if (JSON.stringify(result.structuredContent).length <= maxResultChars) output.structuredContent = result.structuredContent;
    else { output.structuredContent = { truncated: true, notice: '结构化结果超过 12000 字符，已省略。' }; truncated = true; }
  }
  if (truncated) output.truncated = true;
  return output;
}

function requestError(error, signal, serverName) {
  if (signal?.aborted && signal.reason?.name !== 'TimeoutError') return new Error('用户取消任务');
  if (signal?.reason?.name === 'TimeoutError' || /timeout|timed out/i.test(error.message) || error.code === 'REQUEST_TIMEOUT') return new Error(`MCP 服务 ${serverName} 请求超时`);
  return new Error(`MCP 服务 ${serverName}：${error.message}`);
}

// servers 是显式启动配置；它启动本地进程，因此配置必须来自用户信任的文件。
// 连接完成后，tools 与普通本地工具具有相同接口，agent 循环无需懂 MCP 协议。
export async function connectMcpServers(servers, { signal, timeoutMs = 30000 } = {}) {
  checkTimeout(timeoutMs);
  if (!Array.isArray(servers)) throw new Error('MCP servers 必须是数组');
  const names = new Set();
  for (const server of servers) {
    if (!server || typeof server.name !== 'string' || !server.name.trim() || typeof server.command !== 'string' || !server.command.trim()
      || !Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string')
      || (server.cwd !== undefined && typeof server.cwd !== 'string')) throw new Error('MCP 配置必须包含 name、command 和字符串数组 args');
    if (names.has(server.name)) throw new Error(`MCP 服务名称重复：${server.name}`);
    names.add(server.name);
  }
  signal?.throwIfAborted();
  const sessions = [], tools = [], registered = new Set();
  const close = async () => { await Promise.all(sessions.map(session => session.close())); };
  try {
    for (const server of servers) {
      signal?.throwIfAborted();
      // SDK 默认只继承 PATH 等基础环境变量，不把本项目的 DeepSeek 密钥传给服务。
      const transport = new StdioClientTransport({ command: server.command, args: server.args, cwd: server.cwd, stderr: 'pipe', maxBufferSize: 1024 * 1024 });
      transport.stderr?.on('data', () => {}); // 持续消费 stderr，防止子进程因管道填满而停住。
      const client = new Client({ name: 'learning-agent', version: '1.0.0' });
      let closed = false, closing;
      const session = {
        close() {
          if (!closing) {
            closed = true;
            closing = (async () => {
              // failed connect 也可能已创建子进程，finally 再关闭 transport 确保回收。
              try { await client.close(); } finally { await transport.close(); }
            })();
          }
          return closing;
        },
      };
      sessions.push(session);
      client.onclose = () => { closed = true; };
      const startupSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
      let listing;
      try {
        await client.connect(transport, { signal: startupSignal, timeout: timeoutMs, maxTotalTimeout: timeoutMs });
        listing = await client.listTools(undefined, { signal: startupSignal, timeout: timeoutMs, maxTotalTimeout: timeoutMs });
      } catch (error) { throw requestError(error, startupSignal, server.name); }
      if (listing.tools.length > 100) throw new Error(`MCP 服务 ${server.name} 工具超过 100 个`);
      for (const remote of listing.tools) {
        if (typeof remote.name !== 'string' || !remote.name || !remote.inputSchema || remote.inputSchema.type !== 'object') throw new Error(`MCP 服务 ${server.name} 返回无效的工具定义`);
        const name = toolName(server.name, remote.name);
        if (registered.has(name)) throw new Error(`MCP 工具名称冲突：${name}`);
        registered.add(name);
        // 用官方 SDK 的 JSON Schema 校验器校验服务提供的参数定义，避免手写半套规则。
        const validator = new AjvJsonSchemaValidator().getValidator(remote.inputSchema);
        const validate = args => {
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('MCP 工具参数必须是对象');
          const result = validator(args);
          if (!result.valid) throw new Error(`MCP 工具参数不符合定义：${result.errorMessage}`);
        };
        tools.push({
          name, source: `MCP/${server.name}`, description: `[MCP/${server.name}] ${remote.description ?? remote.name}`.slice(0, 4000),
          parameters: remote.inputSchema, validate,
          ...(!isTrustedDemo(server, remote.name) ? { preview: async args => `MCP 服务：${server.name}\n工具：${remote.name}\n参数：${JSON.stringify(args, null, 2)}` } : {}),
          async execute(args, { signal: callSignal, timeoutMs: callTimeout = timeoutMs } = {}) {
            validate(args); checkTimeout(callTimeout);
            const requestSignal = AbortSignal.any([AbortSignal.timeout(callTimeout), ...(callSignal ? [callSignal] : []), ...(signal ? [signal] : [])]);
            try {
              requestSignal.throwIfAborted();
              if (closed) throw new Error('连接已关闭或服务已断开');
              const result = await client.callTool({ name: remote.name, arguments: args }, { signal: requestSignal, timeout: callTimeout, maxTotalTimeout: callTimeout });
              const output = readableResult(result);
              // MCP 的 isError 是工具失败，转换成异常让现有 agent 输出 ok:false。
              if (result.isError) throw new Error(output.content.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 1000) || '工具返回错误');
              return output;
            } catch (error) { throw requestError(error, requestSignal, server.name); }
          },
        });
      }
    }
    return { tools, close };
  } catch (error) {
    await close();
    throw error;
  }
}
