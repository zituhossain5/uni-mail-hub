# Compose images and attachments

The current review environment is http://144.91.77.61:4395/inbox. The live API and worker run backend release `attachments-20261024-4e62adaf144c` with attachment support. The production website keeps its existing design; the new inbox and Compose controls remain on this dev server.

Compose supports clipboard image files, embedded PNG/JPEG/GIF/WebP data in formatted HTML, an inline image picker, file attachments, and dropping files into the editor. Pasted rich text and tables remain editable alongside images. The sandboxed Preview tab embeds the known local image bytes so previews render without granting the frame access to the application origin. Attachment cards show filename, size, inline/attachment status, and a remove action. Inline image removal supports undo. Closing and reopening Compose retains the draft and local files in memory; navigation or reload discards it.

The limits are 20 files, 10 MiB per file, and 20 MiB combined, including inline images. Selected files stay in the browser until submission. Undo history retains local image resources until the draft is sent or the page is closed.

## Live delivery from the dev server

The frontend checks authenticated `GET /api/v1/admin/compose/capabilities`. The live backend now advertises attachment support, so Compose offers **Send message** when local images or files are attached. The normal live account, mailbox permissions, queue, and SMTP configuration apply. Close and reopen Compose to refresh capabilities if it was open during the backend rollout.

If a backend is older or unavailable, the existing explicit **Download test email** fallback remains available. It builds a local `.eml` containing actual file bytes, formatted HTML, a plain-text alternative, and Content-ID links. That fallback does not send or enqueue a message and retains the draft.

## Backend delivery

The shared send schema accepts optional `attachments` with `filename`, `contentType`, `contentBase64`, `disposition` (`attachment` or `inline`), and optional `contentId`. Inline files require an image MIME type and a content ID. Missing or duplicate content IDs, invalid base64, extra fields such as file paths/URLs, and size/count excesses are rejected. Attachment-only messages are accepted. No remote file download or filesystem path is accepted.

API submission stores decoded bytes in `OutgoingAttachment` rows in the same nested create as the message, recipients, and durable outbox event. The request hash includes the attachment data. The worker reads the stored bytes on each attempt and passes buffers to Nodemailer with `contentDisposition` and `cid`; file and URL access are disabled in Nodemailer. The normal mailbox permissions, suppression checks, retry policy, and idempotency behavior continue to apply.

The API and dev relay accept JSON up to 30 MiB only on message submission endpoints to accommodate base64 overhead. The production web relay and UI have not been replaced. Other JSON routes keep their 2 MiB parser/relay limit. The configurable message body limit applies to the envelope and text/HTML, separately from the file limits.

Migration `20261023_outgoing_attachments` creates the attachment table with a cascading message foreign key and byte-count/disposition constraints. The migration was applied to production, the worker was replaced first, and the API was replaced after worker health passed. All 22 migrations and production health checks are clean. The web container, image, and start time are unchanged. See [Separate attachment backend release](backend-attachment-release.md) for deployment and rollback details.

## Checks

`pnpm test:compose` builds the affected packages and runs the sending and compose controller tests. `scripts/sending.test.ts` exercises strict input validation, file and aggregate limits, local SMTP delivery with exact attachment bytes and CID-linked images, and parsing the dev `.eml` download. SMTP tests bind only to loopback and use synthetic addresses. The controller test checks atomic nested persistence with the outbox, unchanged-byte retries, changed-content idempotency rejection, and mailbox authorization without opening a real database or queue connection. The new SQL migration was also tested in a temporary network-isolated PostgreSQL container for byte preservation, size constraints, and cascading deletion; that container was removed. Browser evidence is in `output/composer-attachments/`; browser mailbox requests and send requests are intercepted, and the temporary login session is signed out after testing.
