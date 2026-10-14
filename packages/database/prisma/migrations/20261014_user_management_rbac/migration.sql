-- Existing MEMBER users become VIEWER with no project or mailbox grants. This
-- is deliberately restrictive: an administrator must assign access explicitly.
ALTER TYPE "UserRole" RENAME VALUE 'MEMBER' TO 'VIEWER';
ALTER TYPE "UserRole" ADD VALUE 'MANAGER' BEFORE 'VIEWER';
ALTER TYPE "UserRole" ADD VALUE 'STAFF' BEFORE 'VIEWER';
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'VIEWER';

CREATE TABLE "ProjectMember" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProjectMember_userId_projectId_key" ON "ProjectMember"("userId", "projectId");
CREATE INDEX "ProjectMember_projectId_userId_idx" ON "ProjectMember"("projectId", "userId");
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UserMailboxAccess" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "mailboxId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserMailboxAccess_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserMailboxAccess_userId_mailboxId_key" ON "UserMailboxAccess"("userId", "mailboxId");
CREATE INDEX "UserMailboxAccess_mailboxId_userId_idx" ON "UserMailboxAccess"("mailboxId", "userId");
ALTER TABLE "UserMailboxAccess" ADD CONSTRAINT "UserMailboxAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserMailboxAccess" ADD CONSTRAINT "UserMailboxAccess_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UserInvitation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserInvitation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserInvitation_tokenHash_key" ON "UserInvitation"("tokenHash");
CREATE INDEX "UserInvitation_userId_acceptedAt_revokedAt_idx" ON "UserInvitation"("userId", "acceptedAt", "revokedAt");
CREATE INDEX "UserInvitation_expiresAt_idx" ON "UserInvitation"("expiresAt");
ALTER TABLE "UserInvitation" ADD CONSTRAINT "UserInvitation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
