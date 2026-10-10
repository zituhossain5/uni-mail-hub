import json
import logging
import os
import re
import unittest
from unittest.mock import patch

import httpx

from uni_mail import (
    AsyncUniMail, MessageStatus, Recipient, UniMail, UniMailConnectionError,
    UniMailError, UniMailTimeoutError,
)


BASE = "http://127.0.0.1:4000"
MAILBOX = "cm12345678901234567890123"
MESSAGE = "cm12345678901234567890124"
SECRET = "synthetic-test-api-key"


def client(handler):
    return UniMail(base_url=BASE, api_key=SECRET, mailbox_id=MAILBOX,
                   transport=httpx.MockTransport(handler))


class ConfigurationTests(unittest.TestCase):
    def test_from_env_and_missing_values(self):
        with patch.dict(os.environ, {
            "UNI_MAIL_HUB_URL": BASE, "UNI_MAIL_HUB_API_KEY": SECRET,
            "UNI_MAIL_HUB_MAILBOX_ID": MAILBOX,
        }, clear=True):
            with UniMail.from_env() as mail:
                self.assertEqual(mail.mailbox_id, MAILBOX)
            self.assertEqual(AsyncUniMail.from_env().mailbox_id, MAILBOX)
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "UNI_MAIL_HUB_URL.*UNI_MAIL_HUB_API_KEY.*UNI_MAIL_HUB_MAILBOX_ID") as caught:
                UniMail.from_env()
            self.assertNotIn(SECRET, str(caught.exception))

    def test_rejects_unsafe_configuration_without_echoing_secret(self):
        for url in ("http://remote.example.test", "https://user:pass@example.test",
                    "https://example.test/other", "https://example.test?key=value"):
            with self.subTest(url=url), self.assertRaises(ValueError) as caught:
                UniMail(base_url=url, api_key=SECRET, mailbox_id=MAILBOX)
            self.assertNotIn(SECRET, str(caught.exception))
        with self.assertRaisesRegex(ValueError, "timeout"):
            UniMail(base_url=BASE, api_key=SECRET, mailbox_id=MAILBOX, timeout=0)


class SendingTests(unittest.TestCase):
    def test_send_serialization_headers_and_automatic_idempotency(self):
        captured = []

        def handler(request):
            captured.append(request)
            return httpx.Response(202, json={"id": MESSAGE, "status": "QUEUED", "createdAt": "2026-10-10T00:00:00Z"})

        with client(handler) as mail:
            result = mail.send(to=["a@example.com", Recipient("b@example.com", "B")],
                               cc="copy@example.com", bcc="blind@example.com",
                               reply_to=Recipient("visitor@example.com", "Visitor"),
                               subject="Hello", text="Plain", html="<p>HTML</p>")
        request = captured[0]
        self.assertEqual(str(request.url), BASE + "/api/v1/messages")
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.headers["Authorization"], "Bearer " + SECRET)
        self.assertEqual(request.headers["Content-Type"], "application/json")
        self.assertRegex(request.headers["Idempotency-Key"], r"^[0-9a-f-]{36}$")
        self.assertEqual(result.idempotency_key, request.headers["Idempotency-Key"])
        self.assertEqual(result.id, MESSAGE)
        self.assertEqual(json.loads(request.content), {
            "fromMailboxId": MAILBOX,
            "to": [{"email": "a@example.com"}, {"email": "b@example.com", "name": "B"}],
            "cc": [{"email": "copy@example.com"}], "bcc": [{"email": "blind@example.com"}],
            "replyTo": {"email": "visitor@example.com", "name": "Visitor"},
            "subject": "Hello", "text": "Plain", "html": "<p>HTML</p>",
        })

    def test_explicit_key_is_preserved_across_caller_retries(self):
        keys = []

        def handler(request):
            keys.append(request.headers["Idempotency-Key"])
            return httpx.Response(202, json={"id": MESSAGE, "status": "QUEUED", "createdAt": "2026-10-10T00:00:00Z"})

        with client(handler) as mail:
            first = mail.send(to="a@example.com", subject="Same", text="Same", idempotency_key="submission-123")
            second = mail.send(to="a@example.com", subject="Same", text="Same", idempotency_key="submission-123")
        self.assertEqual(keys, ["submission-123", "submission-123"])
        self.assertEqual(first.idempotency_key, second.idempotency_key)

    def test_get_message_returns_structured_status(self):
        def handler(request):
            self.assertEqual(str(request.url), BASE + "/api/v1/messages/" + MESSAGE)
            self.assertNotIn("Idempotency-Key", request.headers)
            return httpx.Response(200, json={
                "id": MESSAGE, "status": "SMTP_ACCEPTED", "subject": "Hello",
                "createdAt": "2026-10-10T00:00:00Z", "queuedAt": None, "processingAt": None,
                "smtpAcceptedAt": "2026-10-10T00:00:01Z", "failedAt": None,
                "lastErrorCode": None,
                "fromMailbox": {"id": MAILBOX, "email": "test@example.com"},
                "recipients": [{"type": "TO", "email": "a@example.com", "name": None, "smtpStatus": "ACCEPTED"}],
            })

        with client(handler) as mail:
            status = mail.get_message(MESSAGE)
            self.assertIsInstance(status, MessageStatus)
            self.assertEqual(status.status, "SMTP_ACCEPTED")
            self.assertEqual(status.from_mailbox.id, MAILBOX)
            self.assertEqual(status.recipients[0].email, "a@example.com")
            with self.assertRaises(ValueError):
                mail.get_message("../admin")

    def test_known_api_errors_are_normalized_and_secret_is_not_logged(self):
        safe_cases = ((401, "API_KEY_INVALID"), (401, "API_KEY_REVOKED"),
                      (401, "API_KEY_EXPIRED"), (403, "SENDER_NOT_AUTHORIZED"),
                      (409, "RECIPIENT_SUPPRESSED"), (429, "RATE_LIMIT_EXCEEDED"),
                      (409, "IDEMPOTENCY_CONFLICT"))
        captured_logs = []

        class Capture(logging.Handler):
            def emit(self, record):
                captured_logs.append(record.getMessage())

        log_handler = Capture()
        logger = logging.getLogger()
        logger.addHandler(log_handler)
        try:
            for http_status, code in safe_cases:
                with self.subTest(code=code):
                    with client(lambda _: httpx.Response(http_status, json={"code": code, "message": "stack " + SECRET})) as mail:
                        with self.assertRaises(UniMailError) as caught:
                            mail.send(to="a@example.com", subject="Hello", text="Body")
                    self.assertEqual(caught.exception.status_code, http_status)
                    self.assertEqual(caught.exception.code, code)
                    self.assertTrue(re.fullmatch(r"[0-9a-f-]{36}", caught.exception.idempotency_key))
                    self.assertNotIn(SECRET, str(caught.exception))
                    self.assertNotIn(SECRET, repr(caught.exception))
            self.assertNotIn(SECRET, "\n".join(captured_logs))
        finally:
            logger.removeHandler(log_handler)

    def test_timeout_and_connection_error_preserve_retry_key_without_leak(self):
        for exception_type, expected_type in ((httpx.ReadTimeout, UniMailTimeoutError),
                                              (httpx.ConnectError, UniMailConnectionError)):
            def handler(request):
                raise exception_type(SECRET, request=request)

            with client(handler) as mail:
                with self.assertRaises(expected_type) as caught:
                    mail.send(to="a@example.com", subject="Hello", text="Body", idempotency_key="same-123")
            self.assertEqual(caught.exception.idempotency_key, "same-123")
            self.assertNotIn(SECRET, str(caught.exception))

    def test_validation_details_drop_unexpected_server_fields(self):
        payload = {"code": "VALIDATION_ERROR", "message": "stack " + SECRET,
                   "details": {"formErrors": ["Body required"],
                               "fieldErrors": {"to": ["Invalid email"]},
                               "stack": SECRET}}
        with client(lambda _: httpx.Response(400, json=payload)) as mail:
            with self.assertRaises(UniMailError) as caught:
                mail.send(to="a@example.com", subject="Hello", text="Body")
        self.assertEqual(caught.exception.details, {"fields": ["to"], "formErrorCount": 1})
        self.assertNotIn(SECRET, repr(caught.exception.details))

    def test_input_errors_never_send(self):
        calls = []
        with client(lambda request: calls.append(request)) as mail:
            for kwargs in ({"to": [], "subject": "Hello", "text": "Body"},
                           {"to": "a@example.com", "subject": "", "text": "Body"},
                           {"to": "a@example.com", "subject": "Hello"},
                           {"to": "a@example.com", "subject": "Hello", "text": "Body", "idempotency_key": "bad key"}):
                with self.assertRaises((ValueError, TypeError)):
                    mail.send(**kwargs)
        self.assertEqual(calls, [])


class AsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_send_and_status_lookup_share_contract(self):
        seen = []

        def handler(request):
            seen.append(request)
            if request.method == "POST":
                return httpx.Response(202, json={"id": MESSAGE, "status": "QUEUED", "createdAt": "2026-10-10T00:00:00Z"})
            return httpx.Response(200, json={
                "id": MESSAGE, "status": "SMTP_ACCEPTED", "subject": "Hello",
                "createdAt": "2026-10-10T00:00:00Z", "queuedAt": None, "processingAt": None,
                "smtpAcceptedAt": "2026-10-10T00:00:01Z", "failedAt": None,
                "lastErrorCode": None, "fromMailbox": {"id": MAILBOX, "email": "test@example.com"},
                "recipients": [],
            })

        async with AsyncUniMail(base_url=BASE, api_key=SECRET, mailbox_id=MAILBOX,
                                transport=httpx.MockTransport(handler)) as mail:
            sent = await mail.send(to="a@example.com", subject="Hello", html="<p>Hello</p>",
                                   idempotency_key="stable-123")
            status = await mail.get_message(sent.id)
        self.assertEqual(seen[0].headers["Idempotency-Key"], "stable-123")
        self.assertEqual(status.status, "SMTP_ACCEPTED")


if __name__ == "__main__":
    unittest.main()
