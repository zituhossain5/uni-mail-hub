# Search and Unified Inbox (Module 7)

`GET /api/v1/mail/search` searches synchronized PostgreSQL mail. It requires the same signed-in `SUPER_ADMIN` role as the existing webmail endpoints. The current application does not define per-user mailbox grants for `ADMIN` or `MEMBER`; those roles cannot use webmail or this endpoint. Mailbox IDs are validated before any message query. Project and mailbox filters narrow the result set, and a selected mailbox never merges its identity with another mailbox.

## API

Query parameters:

| Parameter | Meaning |
| --- | --- |
| `q` | Subject, sender name/email, plain-text body, Message-ID, or recipient name/email. Literal substring and PostgreSQL simple-language token matches. |
| `mailboxIds` / `projectIds` | Comma-separated IDs; each list may contain up to 100 IDs. All accessible mailboxes are included when omitted. |
| `projectId` | One project ID for API clients. |
| `folder` | IMAP special use: `INBOX` (default), `SENT`, `DRAFTS`, `TRASH`, `JUNK`, `ARCHIVE`, `OTHER`, or `ALL`. |
| `folderId` | One synchronized folder ID; takes precedence over `folder`. |
| `from` / `to` | Exact email address, case insensitive. `to` checks To recipients. |
| `after` / `before` | Message date range. Date-only `before` includes the whole selected UTC day. |
| `unread` / `flagged` / `hasAttachment` | `true` or `false`; filters matching messages. |
| `limit` / `cursor` | Page size 1–100 (default 50), and opaque cursor from the prior response. |

Example: `/api/v1/mail/search?q=invoice&projectIds=<id>&unread=true&after=2026-10-01`. Filter values are validated and bound as SQL parameters. Search literals escape SQL wildcard characters. The query uses PostgreSQL full-text and trigram indexes; it does not require an external search service.

The response has `items` and `nextCursor`. Each item is a lightweight conversation summary with the latest sender, subject, safe plain-text snippet, latest date, message count, mailbox, project, folder, flags, and attachment indicator. `matchedOlderMessage` and `matchSnippet` indicate when an older message matched. Full bodies, full recipient lists, and attachment contents are excluded. One row represents one thread **within one mailbox and folder**. Pagination sorts by latest message date and message ID. Changes caused by sync or flag actions can move rows between pages, so refresh a view after such changes.

## Views and actions

The sidebar links to **Unified Inbox**, **Search**, **Unread**, **Flagged**, and **Attachments**. The scope panel supports all allowed mailboxes, one or several selected projects, selected mailboxes, and a single mailbox. The URL stores the current filters, so returning from a conversation restores the search state. No separate saved-filter service is included.

The result link opens the existing thread reader under its original mailbox and folder route. Reply, Forward, mark read/unread, flag/unflag, archive, move, and attachment actions continue to use the existing APIs with the original mailbox/message IDs. Back to results or `Esc` re-queries the active view, so an item that no longer matches Unread or Flagged disappears. Search never changes the remote read flag simply by opening a result.

Keyboard shortcuts in a result list: `/` focuses the search field; `↑`/`↓` or `j`/`k` selects a conversation; `Enter` or `o` opens it; `Esc` in the reader returns to the prior result URL. These shortcuts do not trigger while typing in a field. There are no destructive shortcuts.

## Limits and verification

Search includes only synchronized data. HTML-only bodies are used for a sanitized plain-text snippet, but the query indexes plain-text bodies only. Search may take longer when a mailbox contains a very large number of matching threads; the endpoint never transfers all results or full bodies. The indexed query and 50-row cursor keep ordinary pages bounded. IMAP Sent remains independent of local Outgoing Mail.

Run `pnpm test:module7:smoke` with the local app and PostgreSQL running. It creates two disposable mailbox fixtures, checks search fields, filters, thread identity, pagination, access control, injection literals, safe snippets, and unread/flagged state changes, then removes its fixtures. For a manual check, use only controlled test mailboxes: synchronize them, open Unified Inbox, use subject/sender searches and the filter panel, open a result and return, and confirm an explicit mark-read or unflag action removes a matching item after the view refreshes. Do not use unrelated private mail for manual verification.
