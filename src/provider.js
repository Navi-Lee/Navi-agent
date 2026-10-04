import { setTimeout as delay } from 'node:timers/promises';

export function createDeepSeekProvider({ apiKey, baseUrl = 'https://api.deepseek.com', model = 'deepseek-flash', timeoutMs = 60000, retries = 2, retryDelayMs = 500, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('请在 .env 中设置 DEEPSEEK_API_KEY');
  return {
    async complete(messages, tools, { signal } = {}) {
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        const requestSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
        let retryable = false;
        try {
          let response;
          try {
            // 模型在远端运行：消息和工具说明书通过 HTTP 发送，API Key 只放请求头。
            response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
              method: 'POST', signal: requestSignal,
              headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model, messages, ...(tools.length ? { tools } : {}), stream: false, thinking: { type: 'disabled' } }),
            });
          } catch (error) { retryable = true; throw error; }
          if (!response.ok) {
            retryable = response.status === 429 || response.status >= 500;
            throw new Error(`DeepSeek HTTP ${response.status}：${response.status === 401 ? '密钥无效' : response.status === 429 ? '请求限流' : '请求失败'}`);
          }
          const data = await response.json();
          const message = data.choices?.[0]?.message;
          if (!message || message.role !== 'assistant' || (!message.tool_calls?.length && typeof message.content !== 'string')) throw new Error('DeepSeek 返回了无效的消息');
          if (data.choices[0].finish_reason === 'length') throw new Error('模型输出达到长度限制，请缩小任务');
          // Non-thinking provider intentionally does not expose hidden reasoning.
          return { message: { role: 'assistant', content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) }, usage: data.usage ?? {} };
        } catch (error) {
          signal?.throwIfAborted();
          if (!retryable || attempt >= retries) throw error;
          await delay(retryDelayMs * 2 ** attempt, undefined, { signal });
        }
      }
    },
  };
}
