import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

const leaseMs = 600000;
const renewScript = "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) else return 0 end";
const releaseScript = "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";

export async function withMailboxSyncLease(connection: Redis, mailboxId: string, operation: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
  const lockKey = `mail-sync:lease:${mailboxId}`;
  const token = randomUUID();
  if (await connection.set(lockKey, token, 'PX', leaseMs, 'NX') !== 'OK') return false;
  const abort = new AbortController();
  const heartbeat = setInterval(() => {
    void connection.eval(renewScript, 1, lockKey, token, leaseMs)
      .then(result => { if (result !== 1) abort.abort(); })
      .catch(() => abort.abort());
  }, 20000);
  try { await operation(abort.signal); return true; }
  finally {
    clearInterval(heartbeat);
    try { await connection.eval(releaseScript, 1, lockKey, token); }
    catch { /* lease expires if Redis is unavailable */ }
  }
}
