# cPanel discovery (Module 8)

## Setup

1. Sign in as a Super Admin and open **System → cPanel Accounts**.
2. Create an API token in cPanel under **Security → Manage API Tokens**. Enter the cPanel username, public host (or public IPv4 address), HTTPS port 2083, and token. The token is shown only in the creation form and cannot be read back. Use **Replace token** to rotate it.
3. Use **Test connection** to verify DNS, TLS, authentication, and UAPI access. The result uses normalized status and error codes; raw responses and tokens are not returned or logged.
4. Choose **Discover now**. Discovery runs in the worker queue; the page refreshes while it is queued or running. The latest result and history remain visible.

The integration uses cPanel UAPI `DomainInfo/list_domains`, `Email/list_pops_with_disk`, and `Email/list_forwarders`. cPanel [documents token authentication](https://api.docs.cpanel.net/cpanel/tokens), [domain listing](https://api.docs.cpanel.net/specifications/cpanel.openapi/domain-information/domaininfo-list_domains), [mailbox disk listing](https://api.docs.cpanel.net/specifications/cpanel.openapi/email-accounts/email-list_pops_with_disk), and [forwarders](https://api.docs.cpanel.net/specifications/cpanel.openapi/email-forwarding/email-list_forwarders). Forwarder access depends on the server's enabled features. Forwarder failure produces a partial run and does not discard successfully discovered domains or mailboxes.

Connection logs report only the operation, stage (`DNS`, `PINNING`, `TCP`, `TLS`, `HTTP`, `UAPI`), status, and normalized error code. They do not include tokens, Authorization headers, or response data. Node's DNS auto-selection may request an address array; the pinned lookup returns only the validated address in the requested shape while keeping the original hostname for the HTTP Host header, TLS SNI, and certificate verification. The client accepts both nested and top-level UAPI result envelopes. A completed connection test returns a structured status; the UI shows green only for `CONNECTED` and an error notification for failed statuses.

## Reconciliation and import

Discovered domains, mailboxes, and forwarders are stored separately from the managed registry. The mailbox view shows **New**, **Managed**, **Missing**, or **Ignored**. Matching uses normalized email addresses. A successful complete domain and mailbox scan can mark previously seen mailboxes missing; it never deletes a managed mailbox. An incomplete scan does not mark mailboxes missing. Ignored mailboxes remain ignored until restored, unless they become managed. Discovery is manual; no schedule is enabled.

Select **Import** on a new mailbox. Choose an existing project or create one, then choose an active shared mail server or explicitly create one. The import reuses an existing Domain only if it belongs to the chosen Project, otherwise creates the Domain as unverified. It rejects duplicate mailboxes and conflicting domain mappings. If you choose to create a mail server, confirm that the entered host actually serves IMAP 993 and SMTP 465 with TLS. The cPanel web host can differ from the mail host.

Import creates mailbox metadata with **Credential status: Not configured**. cPanel does not reveal mailbox passwords. Use the existing mailbox credential flow to configure IMAP/SMTP separately. Removing a cPanel account removes its encrypted token and discovery history, while managed projects, domains, mail servers, and mailboxes stay intact. Account removal waits for active discovery to finish.

## Quota and limits

The integration stores cPanel byte fields when present. It falls back to documented numeric megabyte values when byte fields are absent. Missing values remain unknown. Unlimited quota remains distinct from zero; no usage percentage is calculated for unlimited or unknown quota. The UI highlights 80%, 90%, and 100% usage. Forwarders are read only; aliases are shown only when included in cPanel's forwarder response. No mailbox creation, deletion, password management, or DNS management is performed.

## Security

Only Super Admins can call the cPanel endpoints. API tokens use the existing AES-256-GCM credential vault and are never returned after saving. Requests use HTTPS port 2083 with certificate verification, no redirects, a 10-second request timeout, response-size limits, and a public-host check with DNS resolution pinned to the validated address. Private, loopback, and link-local destinations are blocked. Configuration and discovery actions are audited without secrets.

## Controlled live verification

Use a dedicated cPanel test account with a disposable mailbox. Add it, test the connection, run discovery, and verify domains, mailboxes, quota, and any permitted forwarders. Check that an existing Uni Mail Hub test mailbox is matched as managed. Import one disposable mailbox and confirm its credentials are **Not configured**. Rerun discovery to check that no duplicate registry records appear. If testing a missing mailbox, remove only a disposable mailbox in cPanel and rerun discovery; confirm Uni Mail Hub retains its managed record and marks the source missing. Do not use private production mailbox contents for this test.
