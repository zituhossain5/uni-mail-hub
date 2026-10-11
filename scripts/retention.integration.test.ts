import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../packages/database/generated/client';
import { readConfig } from '../packages/config/src/index';
import { runRetention } from '../apps/worker/src/retention';

async function main() {
const config = readConfig();
const target = new URL(config.DATABASE_URL);
if (config.NODE_ENV !== 'development' || !['127.0.0.1', 'localhost'].includes(target.hostname) || target.port !== '15432' || target.pathname !== '/unimailhub') {
  throw new Error('RETENTION_INTEGRATION_REQUIRES_LOCAL_DB');
}

const prisma = new PrismaClient();
const ids = Array.from({ length: 4 }, () => randomUUID());
const old = new Date(Date.now() - 200 * 86_400_000);
const recent = new Date();
const rollback = new Error('SYNTHETIC_TEST_ROLLBACK');
try {
  const baseline = await runRetention(prisma, config, true);
  assert(Object.values(baseline.eligible).every(count => count === 0), 'Local database has pre-existing eligible history; skip destructive integration check');
  try {
    await prisma.$transaction(async tx => {
      await tx.monitoringRun.create({ data: { id: ids[0], trigger: 'SYNTHETIC_RETENTION_TEST', status: 'SUCCESS', createdAt: old, completedAt: old } });
      await tx.monitoringResult.create({ data: { runId: ids[0], targetType: 'SYNTHETIC', targetId: ids[0], targetName: 'Synthetic target', checkType: 'SYNTHETIC', status: 'HEALTHY', summary: 'Synthetic check', checkedAt: old } });
      await tx.monitoringRun.create({ data: { id: ids[1], trigger: 'SYNTHETIC_RETENTION_TEST', status: 'SUCCESS', createdAt: recent, completedAt: recent } });
      await tx.monitoringResult.create({ data: { runId: ids[1], targetType: 'SYNTHETIC', targetId: ids[1], targetName: 'Synthetic target', checkType: 'SYNTHETIC', status: 'HEALTHY', summary: 'Synthetic check', checkedAt: recent } });
      await tx.monitoringIssue.create({ data: { id: ids[2], targetType: 'SYNTHETIC', targetId: ids[2], targetName: 'Synthetic target', checkType: 'SYNTHETIC', status: 'RESOLVED', severity: 'WARNING', summary: 'Synthetic resolved issue', firstDetectedAt: old, lastDetectedAt: old, resolvedAt: old } });
      await tx.monitoringIssue.create({ data: { id: ids[3], targetType: 'SYNTHETIC', targetId: ids[3], targetName: 'Synthetic target', checkType: 'SYNTHETIC', status: 'OPEN', severity: 'WARNING', summary: 'Synthetic open issue', firstDetectedAt: old, lastDetectedAt: old } });
      const dry = await runRetention(tx as unknown as PrismaClient, config, true);
      assert.equal(dry.eligible.monitoringResults, 1);
      assert.equal(dry.eligible.monitoringRuns, 1);
      assert.equal(dry.eligible.resolvedMonitoringIssues, 1);
      const live = await runRetention(tx as unknown as PrismaClient, config, false);
      assert.equal(live.deleted.monitoringResults, 1);
      assert.equal(live.deleted.monitoringRuns, 1);
      assert.equal(live.deleted.resolvedMonitoringIssues, 1);
      assert.equal(await tx.monitoringRun.count({ where: { id: ids[0] } }), 0);
      assert.equal(await tx.monitoringResult.count({ where: { runId: ids[0] } }), 0);
      assert.equal(await tx.monitoringRun.count({ where: { id: ids[1] } }), 1);
      assert.equal(await tx.monitoringResult.count({ where: { runId: ids[1] } }), 1);
      assert.equal(await tx.monitoringIssue.count({ where: { id: ids[2] } }), 0);
      assert.equal(await tx.monitoringIssue.count({ where: { id: ids[3] } }), 1);
      throw rollback;
    }, { timeout: 20_000 });
    throw new Error('SYNTHETIC_ROLLBACK_NOT_REACHED');
  } catch (error) {
    if (error !== rollback) throw error;
  }
  assert.equal(await prisma.monitoringRun.count({ where: { id: { in: ids.slice(0, 2) } } }), 0);
  assert.equal(await prisma.monitoringIssue.count({ where: { id: { in: ids.slice(2) } } }), 0);
  console.log('Retention integration passed: old terminal history removed, active/recent history retained, transaction rolled back.');
} finally {
  await prisma.$disconnect();
}
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'RETENTION_INTEGRATION_FAILED');
  process.exitCode = 1;
});
