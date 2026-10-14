-- Two-factor enrollment and recovery codes are retired. User sessions and
-- password hashes remain in their existing tables.
DROP TABLE "RecoveryCode";
DROP TABLE "UserSecurity";
