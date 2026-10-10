# uni-mail

Private, server-side Python client for Uni Mail Hub's HTTP Sending API. It does
not contain SMTP code or store credentials. Python 3.11+ and `httpx` are required.

```powershell
python -m pip install -e D:\projects\uni-mail-hub\clients\python
```

Set `UNI_MAIL_HUB_URL`, `UNI_MAIL_HUB_API_KEY`, and
`UNI_MAIL_HUB_MAILBOX_ID` in the application server environment. Use HTTPS
outside local development.

```python
from uni_mail import UniMail

with UniMail.from_env() as mail:
    sent = mail.send(
        to="client@example.com",
        subject="Hello",
        html="<p>Hello</p>",
        idempotency_key="submission-123",
    )
    status = mail.get_message(sent.id)
```

`AsyncUniMail` offers the same methods under `async with`. The API queues a
message; `send()` does not wait for SMTP delivery. For a retry of the same
logical send, reuse the same idempotency key. The client makes no automatic
HTTP retries. A network or timeout exception carries its original
`idempotency_key` for an explicit retry.

See [Python SDK documentation](../../docs/python-sdk.md) and the
[`examples`](examples) directory. This package is not published to PyPI.

