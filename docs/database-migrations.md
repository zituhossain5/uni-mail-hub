# Prisma migration history

Migration SQL is immutable once successfully applied. Add a new migration for later
schema changes; do not edit an applied `migration.sql`. Git keeps migration SQL at
LF line endings through `.gitattributes` so Windows checkouts preserve its bytes.

If `prisma migrate dev` reports a modified migration, inspect both the file hash
and every matching `_prisma_migrations` row, including rolled-back attempts.
`migrate status` can still report up to date when `migrate dev` rejects a historical
checksum. Back up the database and verify the schema before repairing history.
Never use `migrate reset` to resolve a checksum warning on a database with data.
