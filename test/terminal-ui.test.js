import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createTerminalUI, MenuCancelled } from '../src/terminal-ui.js';

function terminal() {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; return input; };
  output.columns = 100; output.rows = 24;
  let text = ''; output.on('data', chunk => { text += chunk; });
  return { input, output, ui: createTerminalUI({ input, output }), text: () => text };
}
const approval = [{ label: '不执行', value: false }, { label: '执行', value: true }];

test('执行确认默认拒绝；方向键选择后才允许，结束恢复终端', async () => {
  const { input, ui } = terminal();
  let choice = ui.select('执行？', approval);
  input.write('\r'); assert.equal(await choice, false);
  assert.equal(input.isRaw, false); assert.equal(input.listenerCount('keypress'), 0);
  choice = ui.select('执行？', approval);
  input.write('\x1b[B\r'); assert.equal(await choice, true);
  assert.equal(input.isRaw, false); ui.close();
});

test('菜单 Esc 返回，Ctrl+C 与外部取消清理监听器', async () => {
  const { input, ui } = terminal();
  let choice = ui.select('选择', approval);
  input.emit('keypress', '', { name: 'escape' }); assert.equal(await choice, null);
  choice = ui.select('选择', approval);
  input.write('\x03'); await assert.rejects(choice, MenuCancelled);
  const controller = new AbortController();
  choice = ui.select('选择', approval, { signal: controller.signal });
  controller.abort(); await assert.rejects(choice, { name: 'AbortError' });
  assert.equal(input.isRaw, false); assert.equal(input.listenerCount('keypress'), 0);
  assert.equal(input.listenerCount('end'), 0); ui.close();
});

test('文字输入与菜单可以连续切换；关闭和输入结束不会卡住', async () => {
  const { input, ui } = terminal();
  let question = ui.question('任务：'); input.write('hello\r'); assert.equal(await question, 'hello');
  const choice = ui.select('选择', approval); input.write('\x1b[B\r'); assert.equal(await choice, true);
  question = ui.question('任务：'); input.write('world\r'); assert.equal(await question, 'world');
  question = ui.question('任务：'); input.end(); await assert.rejects(question, { name: 'AbortError' });
  ui.close(); assert.throws(() => ui.select('选择', approval), MenuCancelled);
});

test('长菜单滚动并支持首尾跳转，关闭时恢复原来的 raw 状态', async () => {
  const { input, ui, text } = terminal(); input.isRaw = true;
  const choice = ui.select('历史会话', Array.from({ length: 20 }, (_, i) => ({ label: `会话 ${i}`, value: i })));
  assert.throws(() => ui.select('重复', approval), /已有输入/);
  input.emit('keypress', '', { name: 'end' }); input.write('\r');
  assert.equal(await choice, 19); assert.match(text(), /当前 20\/20/); assert.equal(input.isRaw, true);
  const cancelled = ui.select('关闭', approval); ui.close(); await assert.rejects(cancelled, MenuCancelled);
});
