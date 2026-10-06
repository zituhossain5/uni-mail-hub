# Mail actions (Module 6)

Webmail actions are available to signed-in super admins for a selected managed mailbox. Opening a message still does not mark it read. Read/unread, flag/unflag, Archive, Trash, Restore, and Move are explicit actions. No route permanently deletes or expunges mail.

## Remote write boundary

The API and sync worker use the same per-mailbox Redis lease. An action verifies the stored folder, UID, and UIDVALIDITY after opening that folder on the IMAP server. It issues UID-based flag or MOVE commands only after those checks. A stale UID, changed UIDVALIDITY, missing selectable folder, or busy mailbox produces a normalized error. MOVE is available only when the server advertises the MOVE capability; ImapFlow's COPY plus EXPUNGE fallback is never invoked. Archive and Trash resolve actual synchronized special-use folders. Restore moves from Trash to the synchronized Inbox; the generic Move selector handles other destinations.

After a confirmed flag change, the API reads the remote flags back and updates PostgreSQL. After MOVE, it removes the old local UID record; the target copy is discovered by synchronization. Both mutations enqueue a mailbox sync after releasing the lease. IMAP remains the authority. Mutation audit rows contain IDs and action names, not credentials, bodies, or attachment bytes.

## Attachments and CID images

`GET /api/v1/mailboxes/:mailboxId/messages/:messageId/attachments/:attachmentId` checks mailbox/message/attachment ownership, the stored IMAP part, current UIDVALIDITY, and the live MIME structure. It streams the selected UID and part through the authenticated web relay; no binary is persisted in PostgreSQL or on disk. `MAIL_ATTACHMENT_MAX_BYTES` defaults to 10 MiB. Unknown or oversized attachments, missing parts, and changed metadata are rejected. Filenames are reduced to a safe leaf name. Responses use a bounded stream, `Content-Disposition`, `nosniff`, and `Cache-Control: private, no-store`.

An inline `cid:` reference is mapped only to an image attachment with a matching Content-ID on that same message. The reader uses a sandboxed frame without script permission, a restrictive CSP, and an authenticated same-origin image URL. Remote HTTP images remain blocked until **Load remote images** is selected. SVG and other active formats are not rendered inline.

## Reply, Reply All, and Forward

The response dialog previews recipients before submission. Reply uses Reply-To when present, otherwise From. Reply All adds original To and CC recipients, removes duplicates and the sending mailbox, and never reconstructs BCC recipients. Forward accepts explicit recipients and appends a forwarded block with From, Date, Subject, To, and the original plain-text body. Original attachments are not forwarded.

The authenticated response endpoint creates the same durable `OutgoingMessage` and outbox event used by normal admin compose. The SMTP worker sends it through the existing queue and managed sender mailbox. Replies persist validated In-Reply-To and References headers before the job is published, so later IMAP synchronization can group a delivered copy. SMTP acceptance is shown in **Outgoing Mail**; **Sent** still reflects only the synchronized IMAP Sent folder.

## Local verification

1. Run `pnpm db:deploy`, `pnpm db:generate`, and `pnpm dev`. Sign in as a super admin and select the dedicated development mailbox.
2. Open a test message. Use **Mark read**, confirm `\Seen` in cPanel webmail, then **Mark unread** and confirm the reverse. Repeat with **Flag** and **Unflag** for `\Flagged`.
3. Move a controlled test message to Archive, then use **Move to…** to return it to Inbox. Move it to Trash and use **Restore to Inbox**. Wait for each sync and verify both cPanel and Uni Mail Hub agree. Do not use an important message for this step.
4. Download a small test attachment and confirm its filename, MIME type, and bytes. Open a message with a CID image and verify it renders without loading remote HTTP images.
5. With explicitly approved controlled recipients, use Reply, Reply All, and Forward. Check the displayed recipients before sending, inspect Outgoing Mail for SMTP acceptance, then sync the development mailbox and check reply threading. Original attachments are excluded from Forward.
6. Run `pnpm test`, `pnpm test:module6:smoke`, and the Modules 1–5 regression smoke commands.

Permanent deletion, Empty Trash, EXPUNGE, attachment forwarding, local drafts, search, IMAP IDLE, and bounce processing remain outside this module.
