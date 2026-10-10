"""Synthetic SDK send. Run only through scripts/python-sdk-live-smoke.mjs."""

import json
import os
import time

from uni_mail import UniMail, UniMailError


def main() -> None:
    recipient = os.environ["UNI_MAIL_HUB_TEST_RECIPIENT"]
    run_id = os.environ["UNI_MAIL_HUB_TEST_RUN_ID"]
    if recipient != "unimailhubtest@unicodeit.com":
        raise RuntimeError("The live smoke test requires the dedicated test mailbox")
    key = f"python-sdk-live:{run_id}"
    subject = f"Uni Mail Hub Python SDK Synthetic {run_id}"
    body = "Synthetic content created only for Uni Mail Hub Python SDK verification."
    with UniMail.from_env() as mail:
        first = mail.send(to=recipient, subject=subject, text=body, idempotency_key=key)
        second = mail.send(to=recipient, subject=subject, text=body, idempotency_key=key)
        if first.id != second.id:
            raise RuntimeError("Idempotent retry created a second outgoing message")
        deadline = time.monotonic() + 90
        status = mail.get_message(first.id)
        while status.status not in {"SMTP_ACCEPTED", "FAILED"} and time.monotonic() < deadline:
            time.sleep(2)
            status = mail.get_message(first.id)
    print(json.dumps({"message_id": first.id, "status": status.status,
                      "idempotency_key": key, "subject": subject}))


if __name__ == "__main__":
    try:
        main()
    except UniMailError as exc:
        print(json.dumps({"error_code": exc.code, "status_code": exc.status_code}))
        raise SystemExit(1) from None
