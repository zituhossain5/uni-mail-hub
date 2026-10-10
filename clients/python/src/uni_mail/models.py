"""Small typed results matching the public Uni Mail Hub Sending API."""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Recipient:
    email: str
    name: str | None = None


@dataclass(frozen=True, slots=True)
class SendResult:
    id: str
    status: str
    created_at: str
    idempotency_key: str


@dataclass(frozen=True, slots=True)
class MailboxRef:
    id: str
    email: str


@dataclass(frozen=True, slots=True)
class MessageRecipient:
    type: str
    email: str
    name: str | None
    smtp_status: str


@dataclass(frozen=True, slots=True)
class MessageStatus:
    id: str
    status: str
    subject: str
    created_at: str
    queued_at: str | None
    processing_at: str | None
    smtp_accepted_at: str | None
    failed_at: str | None
    last_error_code: str | None
    from_mailbox: MailboxRef
    recipients: tuple[MessageRecipient, ...]

