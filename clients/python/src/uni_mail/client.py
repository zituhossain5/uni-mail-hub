"""Synchronous and asynchronous clients sharing serialization and error rules."""

from __future__ import annotations

import os
import re
from math import isfinite
from collections.abc import Mapping, Sequence
from typing import Any, TypeVar
from urllib.parse import urlsplit
from uuid import uuid4

import httpx

from .errors import UniMailConnectionError, UniMailError, UniMailTimeoutError
from .models import MailboxRef, MessageRecipient, MessageStatus, Recipient, SendResult

Address = str | Recipient
Recipients = Address | Sequence[Address]
_ClientType = TypeVar("_ClientType", bound="_BaseUniMail")
_KEY_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_ID_PATTERN = re.compile(r"^[a-z0-9]{20,40}$")
_CODE_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{1,80}$")
_SAFE_MESSAGES = {
    "API_KEY_INVALID": "The Uni Mail Hub API key is invalid.",
    "API_KEY_REVOKED": "The Uni Mail Hub API key has been revoked.",
    "API_KEY_EXPIRED": "The Uni Mail Hub API key has expired.",
    "API_KEY_SCOPE_DENIED": "The API key does not permit sending.",
    "SENDER_NOT_AUTHORIZED": "This API key cannot send from the configured mailbox.",
    "RECIPIENT_SUPPRESSED": "One or more recipients are suppressed.",
    "RATE_LIMIT_EXCEEDED": "Uni Mail Hub rate limit exceeded.",
    "IDEMPOTENCY_CONFLICT": "This idempotency key was used for a different message.",
    "VALIDATION_ERROR": "The message request is invalid.",
    "MESSAGE_NOT_FOUND": "Message not found.",
    "MAILBOX_DISABLED": "The sender mailbox is disabled.",
    "MAILBOX_NOT_CONFIGURED": "The sender mailbox is not configured.",
    "QUEUE_UNAVAILABLE": "The message may have been saved; retry with the same idempotency key.",
}


def _origin(value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("base_url is required")
    try:
        parsed = urlsplit(value)
        valid_port = parsed.port is None or 1 <= parsed.port <= 65535
    except ValueError:
        raise ValueError("base_url must be a valid HTTP origin") from None
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname or not valid_port
            or parsed.username or parsed.password or parsed.path not in {"", "/"}
            or parsed.query or parsed.fragment):
        raise ValueError("base_url must be an HTTP origin without credentials, path, or query")
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("base_url must use HTTPS except for local development")
    return value.rstrip("/")


def _address(value: Address) -> dict[str, str]:
    if isinstance(value, str):
        value = Recipient(value)
    if not isinstance(value, Recipient) or not isinstance(value.email, str):
        raise TypeError("recipient must be an email string or Recipient")
    email = value.email.strip()
    if not email or "@" not in email or any(char.isspace() for char in email):
        raise ValueError("recipient email is invalid")
    result = {"email": email}
    if value.name is not None:
        if not isinstance(value.name, str) or any(char in value.name for char in "\r\n"):
            raise ValueError("recipient name is invalid")
        result["name"] = value.name
    return result


def _addresses(values: Recipients | None) -> list[dict[str, str]]:
    if values is None:
        return []
    if isinstance(values, (str, Recipient)):
        return [_address(values)]
    if not isinstance(values, Sequence):
        raise TypeError("recipients must be an email, Recipient, or sequence of them")
    return [_address(value) for value in values]


def _body(*, mailbox_id: str, to: Recipients, cc: Recipients | None, bcc: Recipients | None,
          reply_to: Address | None, subject: str, text: str | None, html: str | None) -> dict[str, Any]:
    if not isinstance(subject, str) or not subject.strip():
        raise ValueError("subject is required")
    if not isinstance(text, (str, type(None))) or not isinstance(html, (str, type(None))):
        raise TypeError("text and html must be strings")
    if not text and not html:
        raise ValueError("text or html is required")
    payload: dict[str, Any] = {"fromMailboxId": mailbox_id, "to": _addresses(to),
                               "cc": _addresses(cc), "bcc": _addresses(bcc), "subject": subject}
    if not (payload["to"] or payload["cc"] or payload["bcc"]):
        raise ValueError("at least one recipient is required")
    if reply_to is not None:
        payload["replyTo"] = _address(reply_to)
    if text is not None:
        payload["text"] = text
    if html is not None:
        payload["html"] = html
    return payload


def _decode(response: httpx.Response, idempotency_key: str | None) -> Mapping[str, Any]:
    try:
        payload = response.json()
    except ValueError:
        raise UniMailError(response.status_code, "INVALID_RESPONSE", "Uni Mail Hub returned an invalid response.", idempotency_key=idempotency_key) from None
    if not isinstance(payload, dict):
        raise UniMailError(response.status_code, "INVALID_RESPONSE", "Uni Mail Hub returned an invalid response.", idempotency_key=idempotency_key)
    if not 200 <= response.status_code < 300:
        supplied = payload.get("code")
        code = supplied if isinstance(supplied, str) and _CODE_PATTERN.fullmatch(supplied) else "API_ERROR"
        details = _validation_details(payload.get("details")) if code == "VALIDATION_ERROR" else None
        raise UniMailError(response.status_code, code, _SAFE_MESSAGES.get(code, "Uni Mail Hub request failed."), details, idempotency_key)
    return payload


def _validation_details(value: Any) -> dict[str, Any] | None:
    """Keep field names and counts, never arbitrary server exception text."""
    if not isinstance(value, dict):
        return None
    forms = value.get("formErrors")
    fields = value.get("fieldErrors")
    if not isinstance(forms, list) or not isinstance(fields, dict):
        return None
    safe_fields = sorted(
        key for key, errors in fields.items()
        if isinstance(key, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,80}", key)
        and isinstance(errors, list)
    )[:50]
    return {"fields": safe_fields, "formErrorCount": min(len(forms), 20)}


def _required_string(payload: Mapping[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str):
        raise UniMailError(None, "INVALID_RESPONSE", "Uni Mail Hub returned an invalid response.")
    return value


def _send_result(payload: Mapping[str, Any], key: str) -> SendResult:
    return SendResult(_required_string(payload, "id"), _required_string(payload, "status"),
                      _required_string(payload, "createdAt"), key)


def _message_status(payload: Mapping[str, Any]) -> MessageStatus:
    source = payload.get("fromMailbox")
    recipients = payload.get("recipients")
    if not isinstance(source, dict) or not isinstance(recipients, list):
        raise UniMailError(None, "INVALID_RESPONSE", "Uni Mail Hub returned an invalid response.")
    try:
        parsed_recipients = tuple(MessageRecipient(
            _required_string(item, "type"), _required_string(item, "email"),
            item.get("name"), _required_string(item, "smtpStatus"),
        ) for item in recipients if isinstance(item, dict))
        if len(parsed_recipients) != len(recipients):
            raise ValueError("invalid recipients")
        optional = {key: payload.get(key) for key in ("queuedAt", "processingAt", "smtpAcceptedAt", "failedAt", "lastErrorCode")}
        if any(value is not None and not isinstance(value, str) for value in optional.values()):
            raise ValueError("invalid status fields")
        return MessageStatus(
            id=_required_string(payload, "id"), status=_required_string(payload, "status"),
            subject=_required_string(payload, "subject"), created_at=_required_string(payload, "createdAt"),
            queued_at=optional["queuedAt"], processing_at=optional["processingAt"],
            smtp_accepted_at=optional["smtpAcceptedAt"], failed_at=optional["failedAt"],
            last_error_code=optional["lastErrorCode"],
            from_mailbox=MailboxRef(_required_string(source, "id"), _required_string(source, "email")),
            recipients=parsed_recipients,
        )
    except (TypeError, ValueError):
        raise UniMailError(None, "INVALID_RESPONSE", "Uni Mail Hub returned an invalid response.") from None


class _BaseUniMail:
    def __init__(self, *, base_url: str, api_key: str, mailbox_id: str, timeout: float = 10.0) -> None:
        self.base_url = _origin(base_url)
        if not isinstance(api_key, str) or not api_key:
            raise ValueError("api_key is required")
        if not isinstance(mailbox_id, str) or not mailbox_id:
            raise ValueError("mailbox_id is required")
        if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be a positive number of seconds")
        self._api_key = api_key
        self.mailbox_id = mailbox_id
        self.timeout = float(timeout)

    @classmethod
    def from_env(cls: type[_ClientType], *, timeout: float = 10.0, **kwargs: Any) -> _ClientType:
        names = ("UNI_MAIL_HUB_URL", "UNI_MAIL_HUB_API_KEY", "UNI_MAIL_HUB_MAILBOX_ID")
        missing = [name for name in names if not os.environ.get(name)]
        if missing:
            raise ValueError("Missing Uni Mail Hub configuration: " + ", ".join(missing))
        return cls(base_url=os.environ[names[0]], api_key=os.environ[names[1]],
                   mailbox_id=os.environ[names[2]], timeout=timeout, **kwargs)

    def _request_headers(self, key: str | None = None) -> dict[str, str]:
        headers = {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}
        if key is not None:
            headers["Idempotency-Key"] = key
        return headers

    def _send_parts(self, *, to: Recipients, subject: str, text: str | None, html: str | None,
                    cc: Recipients | None, bcc: Recipients | None, reply_to: Address | None,
                    idempotency_key: str | None) -> tuple[str, dict[str, Any]]:
        key = str(uuid4()) if idempotency_key is None else idempotency_key
        if not isinstance(key, str) or not _KEY_PATTERN.fullmatch(key):
            raise ValueError("idempotency_key must contain 1-128 safe characters")
        return key, _body(mailbox_id=self.mailbox_id, to=to, cc=cc, bcc=bcc, reply_to=reply_to,
                          subject=subject, text=text, html=html)

    @staticmethod
    def _message_path(message_id: str) -> str:
        if not isinstance(message_id, str) or not _ID_PATTERN.fullmatch(message_id):
            raise ValueError("message_id is invalid")
        return f"/api/v1/messages/{message_id}"


class UniMail(_BaseUniMail):
    """Synchronous, server-side Uni Mail Hub client. No automatic HTTP retries."""

    def __init__(self, *, base_url: str, api_key: str, mailbox_id: str,
                 timeout: float = 10.0, transport: httpx.BaseTransport | None = None) -> None:
        super().__init__(base_url=base_url, api_key=api_key, mailbox_id=mailbox_id, timeout=timeout)
        self._client = httpx.Client(timeout=self.timeout, follow_redirects=False, transport=transport)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> UniMail:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def send(self, *, to: Recipients, subject: str, text: str | None = None, html: str | None = None,
             cc: Recipients | None = None, bcc: Recipients | None = None, reply_to: Address | None = None,
             idempotency_key: str | None = None) -> SendResult:
        key, body = self._send_parts(to=to, subject=subject, text=text, html=html, cc=cc, bcc=bcc,
                                     reply_to=reply_to, idempotency_key=idempotency_key)
        try:
            response = self._client.post(f"{self.base_url}/api/v1/messages", json=body,
                                         headers=self._request_headers(key))
        except httpx.TimeoutException:
            raise UniMailTimeoutError(key) from None
        except httpx.RequestError:
            raise UniMailConnectionError(key) from None
        return _send_result(_decode(response, key), key)

    def get_message(self, message_id: str) -> MessageStatus:
        try:
            response = self._client.get(self.base_url + self._message_path(message_id),
                                        headers=self._request_headers())
        except httpx.TimeoutException:
            raise UniMailTimeoutError() from None
        except httpx.RequestError:
            raise UniMailConnectionError() from None
        return _message_status(_decode(response, None))


class AsyncUniMail(_BaseUniMail):
    """Asynchronous, server-side Uni Mail Hub client. No automatic HTTP retries."""

    def __init__(self, *, base_url: str, api_key: str, mailbox_id: str,
                 timeout: float = 10.0, transport: httpx.AsyncBaseTransport | None = None) -> None:
        super().__init__(base_url=base_url, api_key=api_key, mailbox_id=mailbox_id, timeout=timeout)
        self._client = httpx.AsyncClient(timeout=self.timeout, follow_redirects=False, transport=transport)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> AsyncUniMail:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    async def send(self, *, to: Recipients, subject: str, text: str | None = None, html: str | None = None,
                   cc: Recipients | None = None, bcc: Recipients | None = None,
                   reply_to: Address | None = None, idempotency_key: str | None = None) -> SendResult:
        key, body = self._send_parts(to=to, subject=subject, text=text, html=html, cc=cc, bcc=bcc,
                                     reply_to=reply_to, idempotency_key=idempotency_key)
        try:
            response = await self._client.post(f"{self.base_url}/api/v1/messages", json=body,
                                               headers=self._request_headers(key))
        except httpx.TimeoutException:
            raise UniMailTimeoutError(key) from None
        except httpx.RequestError:
            raise UniMailConnectionError(key) from None
        return _send_result(_decode(response, key), key)

    async def get_message(self, message_id: str) -> MessageStatus:
        try:
            response = await self._client.get(self.base_url + self._message_path(message_id),
                                              headers=self._request_headers())
        except httpx.TimeoutException:
            raise UniMailTimeoutError() from None
        except httpx.RequestError:
            raise UniMailConnectionError() from None
        return _message_status(_decode(response, None))
