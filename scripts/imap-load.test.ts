import assert from 'node:assert/strict';
import { test } from 'node:test';
import type Redis from 'ioredis';
import { withMailboxSyncLease } from '../packages/mail/src/mailbox-lease';

class FakeRedis {
  private locks = new Map<string, string>();
  async set(key: string, token: string) {
    if (this.locks.has(key)) return null;
    this.locks.set(key, token);
    return 'OK';
  }
  async eval(_script: string, _keys: number, key: string, token: string) {
    if (this.locks.get(key) !== token) return 0;
    this.locks.delete(key);
    return 1;
  }
  restart() { this.locks.clear(); }
}

for (const limit of [3, 5, 10]) test(`mock IMAP sync respects concurrency ${limit} and mailbox lease`, async () => {
  const redis = new FakeRedis();
  let active = 0;
  let peak = 0;
  const started = performance.now();
  const mailboxIds = Array.from({ length: 30 }, (_, index) => `module14-mailbox-${index}`);
  for (let offset = 0; offset < mailboxIds.length; offset += limit) {
    await Promise.all(mailboxIds.slice(offset, offset + limit).map(id => withMailboxSyncLease(redis as unknown as Redis, id, async () => {
      active++;
      peak = Math.max(peak, active);
      assert.equal(await withMailboxSyncLease(redis as unknown as Redis, id, async () => { throw new Error('Duplicate mailbox sync'); }), false);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
    })));
  }
  assert.equal(peak, limit);
  assert.equal(active, 0);
  assert.equal(await withMailboxSyncLease(redis as unknown as Redis, mailboxIds[0]!, async () => {}), true);
  console.log(JSON.stringify({ mockImapConcurrency: limit, mailboxes: mailboxIds.length, peak, elapsedMs: Math.round(performance.now() - started) }));
});

test('failure releases mailbox lease and a restart does not leave it permanently locked', async () => {
  const redis = new FakeRedis();
  await assert.rejects(withMailboxSyncLease(redis as unknown as Redis, 'module14-failure', async () => { throw new Error('Synthetic IMAP failure'); }), /Synthetic IMAP failure/);
  assert.equal(await withMailboxSyncLease(redis as unknown as Redis, 'module14-failure', async () => {}), true);
  redis.restart();
  assert.equal(await withMailboxSyncLease(redis as unknown as Redis, 'module14-failure', async () => {}), true);
});
