import { apiGet } from '@/lib/api';
import { DashboardOverview } from '@/components/dashboard-overview';
import type { DashboardActivity, DashboardSummary, InfrastructureHealth } from '@/lib/dashboard';

export default async function Dashboard() {
  const [summary, health, activity] = await Promise.all([
    apiGet<DashboardSummary>('dashboard'),
    apiGet<InfrastructureHealth>('health'),
    apiGet<DashboardActivity>('dashboard/activity'),
  ]);
  if (!summary) return <div className="error-panel" role="alert"><strong>Dashboard data is unavailable</strong><p>Check the API and database connection, then refresh this page.</p></div>;
  return <DashboardOverview summary={summary} health={health} activity={activity}/>;
}
