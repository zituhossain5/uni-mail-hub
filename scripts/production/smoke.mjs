import { createRequire } from 'node:module';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const Redis = require('ioredis');
const origin = process.env.WEB_URL;
const api = process.env.API_URL;
const fail = code => { throw new Error(code); };
const get = async (url, expectedContent) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) fail('HTTP_CHECK_FAILED');
  if (expectedContent && !(await response.text()).includes(expectedContent)) fail('LOGIN_PAGE_MISSING');
  return response;
};

async function main() {
  if (!origin?.startsWith('https://') || !api) fail('SMOKE_ENV_INVALID');
  await get(origin + '/login', 'Sign in to your workspace');
  console.log('OK HTTPS login page');
  await get(api + '/api/v1/health');
  console.log('OK API, PostgreSQL, and Redis health');
  const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 5000 });
  try {
    await redis.connect();
    const raw = await redis.get('monitor:worker:last');
    const beat = raw && JSON.parse(raw);
    const age = Date.now() - Date.parse(beat?.lastHeartbeatAt ?? '');
    if (!Number.isFinite(age) || age < 0 || age > Number(process.env.MONITOR_WORKER_HEARTBEAT_SECONDS || 90) * 1000) fail('WORKER_HEARTBEAT_STALE');
    console.log('OK worker heartbeat');
  } finally { redis.disconnect(); }
}

main().catch(error => { console.error('FAIL ' + (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'PRODUCTION_SMOKE_FAILED')); process.exitCode = 1; });
