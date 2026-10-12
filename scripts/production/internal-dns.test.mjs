import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const run = overrides => spawnSync(process.execPath, ['scripts/production/check.mjs', '--config-only'], {
  env: { ...process.env, EXTERNAL_TLS_TERMINATION: 'true', ...overrides },
  encoding: 'utf8',
});
const expectFailure = (overrides, code) => {
  const result = run(overrides);
  assert.equal(result.status, 1, `expected ${code}`);
  assert.match(result.stderr, new RegExp(`^FAIL ${code}\\s*$`));
};

assert.equal(run({}).status, 0, 'unique aliases should pass Traefik preflight');
expectFailure({ API_URL: 'http://api:4000' }, 'COMPOSE_API_URL_INVALID');
const oldDb = new URL(process.env.DATABASE_URL);
oldDb.hostname = 'postgres';
expectFailure({ DATABASE_URL: oldDb.toString() }, 'DATABASE_SETTINGS_MISMATCH');
expectFailure({ REDIS_URL: 'redis://redis:6379' }, 'REDIS_HOST_INVALID');
console.log('OK Traefik preflight rejects generic shared-network DNS names');
