# User management and project access

Module 16 uses the existing password and session authentication. Two-factor authentication was removed in the earlier authentication change and is not reintroduced. No existing Super Admin password or session is changed by this migration.

## Roles

| Capability | Super Admin | Admin | Manager | Staff | Viewer |
| --- | --- | --- | --- | --- | --- |
| All projects and mailboxes | Yes | Yes | No | No | No |
| Manage users | Yes | Manager, Staff, Viewer only | No | No | No |
| Manage projects | Yes | Yes | No | No | No |
| Manage domains and mailbox registry | Yes | Yes | Assigned projects | No | No |
| Read synchronized mail and search | Yes | Yes | Assigned projects | Granted mailboxes | Granted mailboxes |
| Compose and change mail | Yes | Yes | Assigned projects | Granted mailboxes | No |
| Queue mailbox sync | Yes | Yes | Assigned projects | No | No |
| Read outgoing activity | Yes | Yes | Assigned projects | Granted mailboxes | Granted mailboxes |
| Retry failed outgoing mail | Yes | Yes | No | No | No |
| API keys, webhooks, suppression administration | Yes | Yes | No | No | No |
| cPanel, mail servers, credentials, provisioning | Yes | No | No | No | No |
| View monitoring | Yes | Yes | Assigned targets | Assigned targets | Assigned targets |
| Run monitoring or change DKIM selectors | Yes | Yes | No | No | No |

Global roles are `SUPER_ADMIN` and `ADMIN`. All other roles require `ProjectMember` records. Manager mail access covers all mailboxes in assigned projects. Staff and Viewer need both project membership and an explicit `UserMailboxAccess` grant for each mailbox. No grant means no mail access. These restrictions are applied to database queries and direct mailbox, message, attachment, and outgoing-message routes. The client menu only reflects the backend policy.

Admins and Managers can read a limited mail-server choice list containing only ID, name, and status when assigning a server to a mailbox. Editing a mailbox retains its current server, even if that server is now disabled. Only Super Admin can view or change full mail-server configuration.

Existing `MEMBER` records are deliberately renamed to `VIEWER` by migration `20261014_user_management_rbac`, without automatic project or mailbox grants. An administrator must assign access. Existing Super Admin and Admin accounts retain their roles and passwords. The migration adds `ProjectMember`, `UserMailboxAccess`, and `UserInvitation` with unique constraints and lookup indexes. It does not reset data.

## Invitations and sessions

Super Admin can invite Admin, Manager, Staff, or Viewer. Admin can invite Manager, Staff, or Viewer and cannot manage Admin or Super Admin accounts. A new account starts inactive with an unguessable password hash. The one-time invitation token is generated from 32 random bytes; only its SHA-256 digest is stored. The link uses `/invite#<token>` so the token is a browser fragment, absent from HTTP request paths and proxy access logs. The browser sends it in the body of same-origin invitation requests and removes the fragment from the address bar. The link is shown once for secure manual delivery, expires after 48 hours, and can be renewed to revoke the old link. No password is emailed. Acceptance sets an Argon2 password of at least 16 characters and activates the account.

Disabling an account revokes its sessions immediately. Changing a role or replacing project or mailbox grants revokes all of that user's sessions; guards check current role and grants on every request. A user can change their own password with the current password, which revokes their other sessions. Administrators can revoke all sessions on a user detail page. Active Super Admin accounts cannot be disabled or demoted through user management. Sensitive changes are recorded in `AuditLog` without passwords, raw invitation tokens, or secrets.

Examples:

- Manager Rahim, assigned to Unicode IT and Bunevia, can work with both projects and their mailboxes. Other projects are invisible.
- Staff Sarah, assigned to Unicode IT with a grant for `contact@unicodeit.com`, can read and send from that mailbox. She cannot access `sales@unicodeit.com`, Bunevia, cPanel, API keys, or Users.
- Viewer Client, assigned to Bunevia with one mailbox grant, can inspect its synchronized messages and outgoing activity. They cannot send, mark read, move mail, retry, or change configuration.

## Deployment

Review the migration and take a verified backup before deployment. On production use `prisma migrate deploy` via the existing `bash scripts/deploy-production.sh --update --traefik` workflow (or omit `--traefik` for standalone Nginx). Do not use `migrate dev` or `migrate reset` on production. Check migration status and the scoped account experience after deployment. The migration changes an enum value, so deploy the new API and web images together. Do not run an older image against the changed enum.
