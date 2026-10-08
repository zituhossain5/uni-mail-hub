# Bounce handling and suppressions

IMAP sync inspects new INBOX messages for a `multipart/report; report-type=delivery-status` MIME envelope containing a `message/delivery-status` part. It extracts one `Final-Recipient: rfc822`, `Action`, `Status`, and `Original-Message-ID` (or an embedded original Message-ID). A subject line or human-readable delivery text alone is never bounce evidence.

The DSN is correlated only when its normalized RFC Message-ID and recipient match exactly one SMTP-accepted outgoing message in the **same project**. If an identifier is missing, there are multiple possible matches, or evidence is otherwise uncertain, a `MailBounce` row is stored with `BOUNCE_UNMATCHED` and no outgoing link. The original synced message remains available; no relationship is invented. Duplicate sync of the same IMAP UID creates no second bounce or event.

`Action: failed` plus `5.x.x` is a `HARD_BOUNCE`; `4.x.x` with `failed` or `delayed` is `SOFT_BOUNCE`; other evidence is `UNKNOWN`. On a correlated hard bounce, the SMTP-accepted recipient changes to `BOUNCED` while the SMTP attempt history stays intact. An email is added to the project's suppression list only for that case. Soft and unknown reports never auto-suppress. The `mail.bounced` webhook contains IDs and classification, not the raw DSN or diagnostic text.

New outbound API and admin compose submissions reject a project-suppressed recipient with HTTP 409 `RECIPIENT_SUPPRESSED`. The worker checks again immediately before SMTP for messages that were queued before suppression. In **Projects → project → Suppressions**, admins can add an address manually or remove one to allow future sends. Both actions are audited. Addresses are stored and compared in lowercase; suppressions do not cross project boundaries.

Current conservative limits: one recipient report per DSN message is processed; a multi-recipient or malformed report is stored as uncertain rather than guessed. Original message identifiers absent from the DSN cannot be recovered from subject text. SMTP acceptance confirms handoff only; it does not prove final delivery. The parser does not infer delivery status from provider-specific prose.
