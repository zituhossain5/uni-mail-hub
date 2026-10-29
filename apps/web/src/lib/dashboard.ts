export type DashboardSummary = {
  projects: number; domains: number; mailboxes: number; healthyMailboxes: number;
  warningMailboxes: number; errorMailboxes: number; unknownMailboxes: number; issueMailboxes: number;
  queuedMessages: number; processingMessages: number; retryScheduledMessages: number; smtpAcceptedToday: number; failedToday: number;
  recentActivity: { id: string; action: string; entityType: string; createdAt: string; user: { name: string } | null }[];
  monitoring: { lastCheckedAt: string | null; criticalIssues: number; domainWarnings: number; queueFailures: number; healthyMailboxes: number; attentionMailboxes: number; worker: string };
};
export type InfrastructureHealth = { status: string; database: string; redis: string };
export type DailyMailCount = { date: string; count: number };
export type DashboardActivity = {
  daily: DailyMailCount[];
  recentMessages: { id: string; subject: string; status: string; createdAt: string; recipients: { email: string }[] }[];
  timeZone: string;
};

export function chartGeometry(daily: DailyMailCount[]) {
  const largest = Math.max(1, ...daily.map(day => day.count));
  const magnitude = 10 ** Math.floor(Math.log10(largest / 4));
  const step = Math.ceil(largest / 4 / magnitude) * magnitude;
  const ceiling = Math.max(4, step * 4);
  const points = daily.map((day, index) => ({ ...day, x: 44 + index / Math.max(1, daily.length - 1) * 566, y: 190 - day.count / ceiling * 166 }));
  const line = points.map((point, index) => {
    const previous = points[index - 1];
    if (!previous) return `M ${point.x} ${point.y}`;
    const offset = (point.x - previous.x) / 2;
    return `C ${previous.x + offset} ${previous.y}, ${point.x - offset} ${point.y}, ${point.x} ${point.y}`;
  }).join(' ');
  const first = points[0];
  const last = points[points.length - 1];
  const area = first && last ? `${line} L ${last.x} 190 L ${first.x} 190 Z` : '';
  return { points, line, area, ceiling };
}
