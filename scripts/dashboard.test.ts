import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UserRole } from '../packages/database/generated/client';
import { DashboardController } from '../apps/api/dist/registry.js';
import { chartGeometry } from '../apps/web/src/lib/dashboard';
import { parseAppearance } from '../apps/web/src/lib/appearance';

for (const role of [UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.MANAGER, UserRole.STAFF, UserRole.VIEWER]) {
  test(`dashboard volume and recent messages preserve ${role} scope`, async () => {
    let queryChecked = false;
    let recentChecked = false;
    const global = role === UserRole.SUPER_ADMIN || role === UserRole.ADMIN;
    const db = {
      $queryRaw: async (query: { sql: string; values: unknown[] }) => {
        queryChecked = true;
        assert.match(query.sql, /GROUP BY TO_CHAR/);
        assert.equal(query.sql.includes('ProjectMember'), !global);
        assert.equal(query.sql.includes('UserMailboxAccess'), !global && role !== UserRole.MANAGER);
        assert.equal(query.sql.includes('actor-id'), false);
        if (!global) assert.ok(query.values.includes('actor-id'));
        const [start, end] = query.values as Date[];
        assert.equal(end.getTime() - start.getTime(), 30 * 86_400_000);
        assert.equal(start.getUTCHours(), 0);
        assert.equal(end.getUTCHours(), 0);
        return [{ date: start.toISOString().slice(0, 10), count: 8 }];
      },
      outgoingMessage: { findMany: async (query: { where: { fromMailbox: Record<string, unknown> }; take: number; select: Record<string, unknown> }) => {
        recentChecked = true;
        const scope = query.where.fromMailbox;
        assert.equal(Boolean(scope.project), !global);
        assert.equal(Boolean(scope.userGrants), !global && role !== UserRole.MANAGER);
        assert.equal(query.take, 5);
        assert.equal(query.select.textBody, undefined);
        assert.equal(query.select.htmlBody, undefined);
        return [];
      } },
    };
    const controller = new DashboardController(db as never, {} as never);
    const result = await controller.activity({ user: { id: 'actor-id', role } } as never);
    assert.ok(queryChecked && recentChecked);
    assert.equal(result.timeZone, 'UTC');
    assert.equal(result.daily.length, 30);
    assert.equal(result.daily[0].count, 8);
    assert.ok(result.daily.slice(1).every(day => day.count === 0));
    assert.equal(result.daily[29].date, new Date().toISOString().slice(0, 10));
  });
}

test('chart handles empty, zero, singleton and large counts without invalid geometry', () => {
  for (const counts of [[], [0], [8], [0, 0, 0], [0, 10, 90000, 3]]) {
    const result = chartGeometry(counts.map((count, index) => ({ date: `2026-10-${index + 1}`, count })));
    assert.ok(result.ceiling > 0);
    assert.ok(result.ceiling >= Math.max(0, ...counts));
    assert.ok(!/NaN|Infinity/.test(result.area + result.line));
    assert.ok(result.points.every(point => point.x >= 44 && point.x <= 610 && point.y >= 24 && point.y <= 190));
  }
});

test('appearance preferences allow only known themes and motion modes', () => {
  assert.deepEqual(parseAppearance(null), { theme: 'lavender', motion: 'full' });
  for (const raw of ['bad json', 'null', '123', '{"theme":"unknown","motion":"invalid"}']) {
    assert.deepEqual(parseAppearance(raw), { theme: 'lavender', motion: 'full' });
  }
  assert.deepEqual(parseAppearance('{"theme":"mint","motion":"off"}'), { theme: 'mint', motion: 'off' });
});
