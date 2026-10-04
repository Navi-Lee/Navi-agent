import { emitKeypressEvents, cursorTo, moveCursor, clearScreenDown } from 'node:readline';
import readline from 'node:readline/promises';

export class MenuCancelled extends Error {
  constructor() { super('已取消选择'); this.name = 'MenuCancelled'; }
}

// 一个时刻只有一个输入界面：问文字时创建 readline，选菜单时自己接管按键。
// 两者结束就移除监听器，避免方向键同时被菜单和聊天输入处理。
export function createTerminalUI({ input = process.stdin, output = process.stdout } = {}) {
  let activeCancel, closed = false;
  const ensureIdle = () => {
    if (closed) throw new MenuCancelled();
    if (activeCancel) throw new Error('已有输入正在等待');
  };
  return {
    get closed() { return closed; },
    // 菜单会 resume 输入流；退出时 pause，避免终端继续占住进程。
    close() { closed = true; activeCancel?.(); input.pause(); input.unref?.(); },
    async question(message, { signal } = {}) {
      ensureIdle(); signal?.throwIfAborted();
      const rl = readline.createInterface({ input, output });
      const controller = new AbortController();
      activeCancel = () => controller.abort(new MenuCancelled());
      const interrupt = () => activeCancel?.();
      rl.on('SIGINT', interrupt);
      input.once('end', interrupt);
      try {
        return await rl.question(message, { signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]) });
      } finally {
        activeCancel = undefined;
        rl.removeListener('SIGINT', interrupt);
        input.removeListener('end', interrupt);
        rl.close();
      }
    },
    select(message, options, { initialValue, signal } = {}) {
      ensureIdle(); signal?.throwIfAborted();
      if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') throw new Error('选择菜单需要交互终端');
      if (!options.length) throw new Error('菜单没有选项');
      let selected = Math.max(0, options.findIndex(option => Object.is(option.value, initialValue)));
      const previousRaw = Boolean(input.isRaw);
      const previousPaused = input.isPaused();
      const cleanText = value => String(value).replace(/[\x00-\x1f\x7f]/g, ' ');
      // 只显示一屏；长会话列表随选中项滚动，而不是挤满整个终端。
      const maxRows = Math.max(1, Math.min(8, (output.rows ?? 24) - 4));
      const columns = Math.max(8, output.columns ?? 80);
      let renderedRows = 0;
      const render = () => {
        if (renderedRows) { moveCursor(output, 0, -renderedRows); cursorTo(output, 0); clearScreenDown(output); }
        const first = Math.min(Math.max(0, selected - maxRows + 1), Math.max(0, options.length - maxRows));
        // 中文通常占两列，按一半列数限制长度，使 ANSI 回退的行数保持可靠。
        const rows = [cleanText(message), '↑↓ 选择，Enter 确认，Esc 返回；Ctrl+C 取消'];
        for (let i = first; i < Math.min(first + maxRows, options.length); i++) rows.push(`${i === selected ? '❯' : ' '} ${i + 1}. ${cleanText(options[i].label)}`);
        rows.push(`当前 ${selected + 1}/${options.length}`);
        output.write(rows.map(row => Array.from(row).slice(0, Math.floor(columns / 2)).join('')).join('\n') + '\n');
        renderedRows = rows.length;
      };
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          input.removeListener('keypress', keypress);
          input.removeListener('end', ended);
          signal?.removeEventListener('abort', aborted);
          activeCancel = undefined;
          input.setRawMode(previousRaw);
          if (previousPaused) input.pause();
          output.write('\x1b[?25h');
          if (error) reject(error); else resolve(value);
        };
        const keypress = (text, key = {}) => {
          if (key.ctrl && key.name === 'c') { finish(new MenuCancelled()); return; }
          if (key.name === 'escape') { finish(undefined, null); return; }
          if (key.name === 'return' || key.name === 'enter') { finish(undefined, options[selected].value); return; }
          if (key.name === 'up') selected = (selected + options.length - 1) % options.length;
          else if (key.name === 'down') selected = (selected + 1) % options.length;
          else if (key.name === 'home') selected = 0;
          else if (key.name === 'end') selected = options.length - 1;
          else if (/^[1-9]$/.test(text) && Number(text) <= options.length) selected = Number(text) - 1;
          else return;
          render();
        };
        const ended = () => finish(new MenuCancelled());
        const aborted = () => finish(signal.reason ?? new MenuCancelled());
        activeCancel = () => finish(new MenuCancelled());
        emitKeypressEvents(input);
        input.on('keypress', keypress);
        input.once('end', ended);
        signal?.addEventListener('abort', aborted, { once: true });
        input.setRawMode(true);
        input.resume();
        output.write('\x1b[?25l');
        render();
      });
    },
  };
}
