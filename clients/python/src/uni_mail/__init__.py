"""Server-side HTTP client for Uni Mail Hub."""

from .client import AsyncUniMail, UniMail
from .errors import UniMailConnectionError, UniMailError, UniMailTimeoutError
from .models import MailboxRef, MessageRecipient, MessageStatus, Recipient, SendResult

__all__ = [
    "AsyncUniMail", "MailboxRef", "MessageRecipient", "MessageStatus", "Recipient",
    "SendResult", "UniMail", "UniMailConnectionError", "UniMailError", "UniMailTimeoutError",
]

