// A chatbot makes one model request per turn. It never executes tools.
export function createChatbot({ provider, maxContextChars = 100000, onTrim = () => {} }) {
  const messages = [{ role: 'system', content: '你是一个友好的聊天助手。清楚、准确地回答用户问题。你没有访问文件、联网或执行命令的工具，不要声称执行了这些操作。' }];
  let running = false;
  return {
    messages,
    reset() {
      if (running) throw new Error('请先取消当前请求');
      messages.splice(1);
    },
    async chat(input, { signal } = {}) {
      if (running) throw new Error('已有请求正在运行');
      if (typeof input !== 'string' || !input.trim()) throw new Error('消息不能为空');
      running = true;
      // Commit only a successful user/assistant pair, so retries do not duplicate input.
      const context = [...messages, { role: 'user', content: input }];
      try {
        signal?.throwIfAborted();
        let trimmed = false;
        while (JSON.stringify(context).length > maxContextChars && context.length > 2) {
          context.splice(1, 2); trimmed = true;
        }
        if (JSON.stringify(context).length > maxContextChars) throw new Error('输入过长，请缩小消息');
        const result = await provider.complete(context, [], { signal });
        signal?.throwIfAborted();
        if (result.message.tool_calls?.length || typeof result.message.content !== 'string') throw new Error('聊天模型返回了无效回答');
        messages.splice(0, messages.length, ...context, result.message);
        if (trimmed) onTrim();
        return { content: result.message.content, usage: result.usage };
      } finally { running = false; }
    },
  };
}
