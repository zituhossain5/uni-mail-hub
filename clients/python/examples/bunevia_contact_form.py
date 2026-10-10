"""Call from a trusted Bunevia Python backend after persisting a submission.

The configured sender mailbox is the From address. The visitor is Reply-To.
"""

from uni_mail import UniMail, UniMailError


def send_contact_enquiry(
    submission_id: str, visitor_name: str, visitor_email: str, message: str,
) -> str:
    # submission_id must be a stable server-side ID for this form submission.
    with UniMail.from_env() as mail:
        try:
            sent = mail.send(
                to="sales@bunevia.com",
                reply_to=visitor_email,
                subject=f"New enquiry from {visitor_name}",
                text=f"Visitor: {visitor_name}\nEmail: {visitor_email}\n\n{message}",
                idempotency_key=f"bunevia-contact:{submission_id}",
            )
        except UniMailError as exc:
            # Record the normalized code and stable submission ID for retry.
            # Never log the configured API key or request headers.
            raise RuntimeError(f"Contact enquiry was not accepted: {exc.code}") from None
    return sent.id

