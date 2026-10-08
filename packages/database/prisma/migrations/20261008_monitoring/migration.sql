CREATE TYPE "MonitoringStatus" AS ENUM ('HEALTHY', 'WARNING', 'CRITICAL', 'UNKNOWN');
CREATE TYPE "MonitoringRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');
CREATE TYPE "MonitoringIssueStatus" AS ENUM ('OPEN', 'RESOLVED');

ALTER TABLE "Domain" ADD COLUMN "dkimSelectors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "MonitoringRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "trigger" TEXT NOT NULL,
  "status" "MonitoringRunStatus" NOT NULL DEFAULT 'QUEUED',
  "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3),
  "resultCount" INTEGER NOT NULL DEFAULT 0, "issueCount" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT, "requestedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MonitoringRun_status_createdAt_idx" ON "MonitoringRun"("status", "createdAt");
CREATE INDEX "MonitoringRun_createdAt_idx" ON "MonitoringRun"("createdAt");
CREATE UNIQUE INDEX "MonitoringRun_one_active" ON "MonitoringRun"((1)) WHERE "status" IN ('QUEUED', 'RUNNING');

CREATE TABLE "MonitoringResult" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "targetType" TEXT NOT NULL, "targetId" TEXT NOT NULL, "targetName" TEXT NOT NULL,
  "checkType" TEXT NOT NULL, "status" "MonitoringStatus" NOT NULL,
  "summary" TEXT NOT NULL, "details" JSONB,
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "latencyMs" INTEGER, "errorCode" TEXT,
  CONSTRAINT "MonitoringResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MonitoringRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MonitoringResult_runId_targetType_targetId_checkType_key" ON "MonitoringResult"("runId", "targetType", "targetId", "checkType");
CREATE INDEX "MonitoringResult_targetType_targetId_checkedAt_idx" ON "MonitoringResult"("targetType", "targetId", "checkedAt");
CREATE INDEX "MonitoringResult_status_checkedAt_idx" ON "MonitoringResult"("status", "checkedAt");

CREATE TABLE "MonitoringIssue" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "targetType" TEXT NOT NULL, "targetId" TEXT NOT NULL, "targetName" TEXT NOT NULL,
  "checkType" TEXT NOT NULL, "status" "MonitoringIssueStatus" NOT NULL DEFAULT 'OPEN',
  "severity" "MonitoringStatus" NOT NULL, "summary" TEXT NOT NULL, "errorCode" TEXT,
  "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3), "lastHealthyAt" TIMESTAMP(3)
);
CREATE INDEX "MonitoringIssue_status_severity_lastDetectedAt_idx" ON "MonitoringIssue"("status", "severity", "lastDetectedAt");
CREATE INDEX "MonitoringIssue_targetType_targetId_checkType_status_idx" ON "MonitoringIssue"("targetType", "targetId", "checkType", "status");
CREATE UNIQUE INDEX "MonitoringIssue_one_open_per_check" ON "MonitoringIssue"("targetType", "targetId", "checkType") WHERE "status" = 'OPEN';
