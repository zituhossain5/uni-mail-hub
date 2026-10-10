# Python SDK

`uni-mail` is a private Python 3.11+ package in `clients/python`. It wraps the
existing Uni Mail Hub HTTP Sending API with `httpx`; it has no SMTP dependency.
Use it **only in trusted server-side code**. Never place an API key in browser
JavaScript, a mobile app, or other public client. It is not published to PyPI.

## Install locally

From a separate Python project, install the package without importing source
files from the Uni Mail Hub repository:

```powershell
python -m pip install -e D:\projects\uni-mail-hub\clients\python
python -c "from uni_mail import UniMail, AsyncUniMail; print('installed')"
```

Set these variables in that project's server environment:

```env
UNI_MAIL_HUB_URL=http://127.0.0.1:4000
UNI_MAIL_HUB_API_KEY=YOUR_ONE_TIME_PROJECT_KEY
UNI_MAIL_HUB_MAILBOX_ID=YOUR_AUTHORIZED_SENDER_MAILBOX_ID
```

Use the value of `API_URL` from Uni Mail Hub's local `.env`; change the example
port if that API is listening on a different port.

Use an HTTPS Uni Mail Hub URL outside local development. The configured mailbox
is always the actual From sender; `reply_to` does not change it. Use a project
API key with a sender grant for that mailbox.

## Synchronous and asynchronous sends

```python
from uni_mail import Recipient, UniMail

with UniMail.from_env(timeout=10.0) as mail:
    sent = mail.send(
        to=[Recipient("client@example.com", "Client")],
        cc="copy@example.com",
        reply_to="visitor@example.com",
        subject="Welcome",
        text="Welcome",
        html="<p>Welcome</p>",
        idempotency_key="submission-123",
    )
    status = mail.get_message(sent.id)
    print(sent.id, status.status)
```

`to`, `cc`, and `bcc` accept one email, one `Recipient`, or a sequence of them.
`send` also supports `text`, `html`, `subject`, and `reply_to`. A text or HTML
body and at least one recipient are required. The server queues accepted mail;
`send` returns before SMTP delivery. `get_message` can later report
`SMTP_ACCEPTED` or a failure.

```python
from uni_mail import AsyncUniMail

async with AsyncUniMail.from_env() as mail:
    sent = await mail.send(to="client@example.com", subject="Hello", text="Hello")
    status = await mail.get_message(sent.id)
```

The client generates a UUID idempotency key when omitted and returns it in
`SendResult.idempotency_key`. **Retry the same logical send with the same key.**
The client performs no automatic HTTP retries. If the connection fails or times
out, `UniMailConnectionError` or `UniMailTimeoutError` carries the key for a
manual retry. A new key for an uncertain send may produce a duplicate.

## Errors

`UniMailError` exposes `status_code`, normalized `code`, safe `message`, and
`details` for validation failures. It also carries `idempotency_key` for sends.
Known codes include `API_KEY_INVALID`, `API_KEY_REVOKED`, `API_KEY_EXPIRED`,
`SENDER_NOT_AUTHORIZED`, `RECIPIENT_SUPPRESSED`, `RATE_LIMIT_EXCEEDED`, and
`IDEMPOTENCY_CONFLICT`. The client never includes a raw server stack trace or
API key in an exception message.

```python
from uni_mail import UniMailError, UniMailTimeoutError

try:
    sent = mail.send(to="client@example.com", subject="Hello", text="Hello")
except UniMailTimeoutError as exc:
    # Persist this key with the submission and reuse it for a later retry.
    retry_key = exc.idempotency_key
    raise
except UniMailError as exc:
    # Handle exc.code and exc.status_code according to your application.
    raise
```

## Contact forms and framework examples

[`bunevia_contact_form.py`](../clients/python/examples/bunevia_contact_form.py)
shows an authorized Bunevia mailbox as From and the visitor as Reply-To.
The [FastAPI](../clients/python/examples/fastapi_contact.py),
[Django](../clients/python/examples/django_contact.py), and
[Flask](../clients/python/examples/flask_contact.py) snippets show reusable
server-side clients, form handlers, stable submission IDs, and normalized
error handling. Persist the submission ID before sending, and reuse it for
retries. Do not expose the API key to a form's frontend.

## Migrate from SMTP

Replace application SMTP configuration:

```env
SMTP_HOST=
SMTP_USER=
SMTP_PASSWORD=
```

with the three `UNI_MAIL_HUB_*` values above, then update the application
handler to call `UniMail.send()`. Test with a controlled recipient and remove
the old SMTP secrets after the new path works. No other repository is changed
automatically.

For future distribution, the package can be built into a wheel for a private
Python package registry or installed from a pinned Git revision. Do not
publish it publicly without a separate release review.

## Dedicated mailbox live smoke

With the local API and worker running, install the package into a temporary
Python virtual environment and set `UNI_MAIL_HUB_TEST_PYTHON` to that
environment's `python.exe`. Then run:

```powershell
$env:UNI_MAIL_HUB_TEST_PYTHON = 'C:\path\to\test-venv\Scripts\python.exe'
node --env-file=.env scripts/python-sdk-live-smoke.mjs
```

This script is restricted to `unimailhubtest@unicodeit.com`. It creates a
temporary project API key, sends one new synthetic message to that same
mailbox, repeats the request with the same idempotency key, checks the Outgoing
Mail record and SMTP status, and checks Inbox receipt. It revokes the temporary
key afterward. If normal synchronization is delayed, it performs a read-only
IMAP subject search for only that synthetic message and reports the sync delay
separately. It does not open unrelated messages.
