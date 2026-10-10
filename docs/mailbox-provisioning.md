# cPanel mailbox provisioning

Only SUPER_ADMIN can use cPanel provisioning. Select a project domain, the cPanel
account that owns it, and an active cPanel mail server. The API verifies domain
ownership with `DomainInfo/list_domains` and checks existing mailboxes before
calling `Email/add_pop`. A new 48-byte random password is encrypted with the
existing mailbox vault key. It is sent to cPanel in an HTTPS POST body and never
returned by the API, logged, or queued. The cPanel connection keeps public-IP
validation, DNS pinning, SNI, and certificate checking.

Use Project → Integration to create the mailbox. Choose a finite quota in MB or
Unlimited. The form never treats `0` MB as a finite quota; cPanel receives `0`
only for Unlimited. The selected mail host must provide TLS IMAP on 993 and SMTP
on 465, or choose an existing configured cPanel mail server. Uni Mail Hub tests
IMAP and SMTP after it commits the encrypted credential.

For an existing discovered mailbox, import it first. You can enter its known
password on the mailbox detail page. Alternatively, explicitly rotate it from
Project → Integration. Rotation changes the cPanel password and the encrypted
vault credential, then tests IMAP and SMTP. This can break existing mail clients,
phones, Outlook, Thunderbird, and websites still using the old password.

## Cross-system recovery

PostgreSQL and cPanel cannot share a transaction. Before a create or rotate call,
Uni Mail Hub stores an encrypted recovery credential in `CpanelMailboxChange`
with a unique active mailbox address. After cPanel confirms success, one
PostgreSQL transaction updates the managed mailbox, credential vault, discovery
mapping, audit log, and operation status. Completing it clears the recovery
ciphertext. If that transaction fails, the operation remains PREPARED or CRITICAL;
the API returns `CPANEL_RECOVERY_REQUIRED` and does not claim success.

An administrator can review unresolved operations on the Integration page.
Recovery requires typing the exact mailbox address. For a confirmed remote
create or a rotation, it reapplies the encrypted password in cPanel and updates
the vault. If a create was not confirmed because the response or database failed,
the administrator must first inspect cPanel and explicitly confirm the exact
mailbox belongs to this account; recovery then checks a fresh cPanel mailbox
listing before reapplying the escrowed password. If it is absent, the unconfirmed
create can be abandoned after a fresh listing proves that absence. Do not start
another change while an operation is unresolved. Account removal is blocked
until recovery.

The management routes are under
`/api/v1/cpanel-accounts/:accountId/mailboxes`: POST `/provision`,
`/:mailboxId/rotate`, `/:mailboxId/quota`, `/:mailboxId/suspension`,
`/:mailboxId/delete-from-cpanel`, and
`/changes/:changeId/recover` or `/abandon`. All are SUPER_ADMIN only.

Deletion requires typing the full address and can permanently remove cPanel
mailbox data. It disables the managed mailbox while retaining synchronized
history. A discovery result of MISSING never triggers deletion. Suspension uses
cPanel login and outgoing restrictions. If either remote step fails, the API
reports uncertainty and requires inspection and discovery before retrying.

The cPanel calls follow the official [UAPI token guidance](https://api.docs.cpanel.net/cpanel/tokens)
and [mailbox management functions](https://api.docs.cpanel.net/specifications/cpanel.openapi/email-accounts).
