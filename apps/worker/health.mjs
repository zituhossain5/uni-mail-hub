import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000 });
(async () => {
  await redis.connect();
  const raw = await redis.get('monitor:worker:last');
  const heartbeat = raw && JSON.parse(raw);
  const age = Date.now() - Date.parse(heartbeat?.lastHeartbeatAt ?? '');
  if (!Number.isFinite(age) || age < 0 || age > Number(process.env.MONITOR_WORKER_HEARTBEAT_SECONDS || 90) * 1000) throw new Error('WORKER_HEARTBEAT_STALE');
  await redis.quit();
})().catch(() => { redis.disconnect(); process.exitCode = 1; });
