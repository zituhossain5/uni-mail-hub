import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_READ_DELAY_MS, createAutoReadGate } from '../apps/web/src/lib/auto-read';
import { conversationFlags, plainTextLines, unseenChange } from '../apps/web/src/lib/webmail-state';

class Clock {
  now = 0;
  next = 1;
  tasks = new Map<number, { due: number; run: () => void }>();
  schedule = (run: () => void, delay: number) => {
    const id = this.next++;
    this.tasks.set(id, { due: this.now + delay, run });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  cancel = (timer: ReturnType<typeof setTimeout>) => { this.tasks.delete(timer as unknown as number); };
  tick(milliseconds: number) {
    this.now += milliseconds;
    for (const [id, task] of this.tasks) if (task.due <= this.now) { this.tasks.delete(id); task.run(); }
  }
}

test('loaded visible message marks read after the full dwell, once', async () => {
  const clock = new Clock();
  let calls = 0;
  const gate = createAutoReadGate(async () => { calls++; }, () => assert.fail('unexpected read error'), AUTO_READ_DELAY_MS, clock.schedule, clock.cancel);
  gate.setVisible(true);
  clock.tick(AUTO_READ_DELAY_MS);
  assert.equal(calls, 0, 'visible metadata without a loaded body must not mark read');
  gate.setReady(true);
  clock.tick(AUTO_READ_DELAY_MS - 1);
  assert.equal(calls, 0);
  clock.tick(1);
  await Promise.resolve();
  assert.equal(calls, 1);
  gate.setVisible(false);
  gate.setVisible(true);
  clock.tick(AUTO_READ_DELAY_MS);
  assert.equal(calls, 1);
});

test('leaving or hiding before dwell cancels and restarts the clock', () => {
  const clock = new Clock();
  let calls = 0;
  const gate = createAutoReadGate(async () => { calls++; }, () => assert.fail('unexpected read error'), AUTO_READ_DELAY_MS, clock.schedule, clock.cancel);
  gate.setReady(true);
  gate.setVisible(true);
  clock.tick(600);
  gate.setVisible(false);
  clock.tick(500);
  assert.equal(calls, 0);
  gate.setVisible(true);
  clock.tick(600);
  assert.equal(calls, 0, 'dwell must restart after the tab or reader is hidden');
  gate.dispose();
  clock.tick(1000);
  assert.equal(calls, 0);
});

test('failed mutation reports an error without changing unread state or retrying automatically', async () => {
  const clock = new Clock();
  let calls = 0;
  let error = '';
  const gate = createAutoReadGate(async () => { calls++; throw new Error('The mail server denied this action.'); }, reason => { error = (reason as Error).message; }, AUTO_READ_DELAY_MS, clock.schedule, clock.cancel);
  gate.setReady(true);
  gate.setVisible(true);
  clock.tick(AUTO_READ_DELAY_MS);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(error, 'The mail server denied this action.');
  gate.setVisible(false);
  gate.setVisible(true);
  clock.tick(AUTO_READ_DELAY_MS);
  assert.equal(calls, 1);
  assert.deepEqual(conversationFlags([{ isSeen: false, isFlagged: false }], false), { unread: true, flagged: false });
});

test('confirmed read updates the folder count and removes fully read conversations from Unread', () => {
  assert.equal(unseenChange(false, true), -1);
  assert.equal(unseenChange(true, false), 1);
  assert.equal(unseenChange(true, true), 0);
  const before = [{ isSeen: false, isFlagged: false }, { isSeen: true, isFlagged: false }];
  assert.equal(conversationFlags(before, false).unread, true);
  assert.equal(conversationFlags(before.map(item => ({ ...item, isSeen: true })), false).unread, false);
  assert.equal(conversationFlags([{ isSeen: true, isFlagged: false }], true).unread, null, 'paged older messages must not be assumed read');
});

test('plain text preserves newlines and visually identifies quoted replies', () => {
  const source = 'Hello\n\n> prior message\nThanks';
  const lines = plainTextLines(source);
  assert.equal(lines.map(line => line.text).join(''), source);
  assert.deepEqual(lines.map(line => line.quoted), [false, false, true, false]);
});
