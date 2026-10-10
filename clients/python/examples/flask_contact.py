"""Concise Flask server-side contact endpoint using a reusable client."""

from uuid import UUID

from flask import Flask, jsonify, request
from uni_mail import UniMail, UniMailError


app = Flask(__name__)
mail = UniMail.from_env()


@app.post("/contact")
def contact():
    data = request.get_json(silent=True) or {}
    try:
        # Persist this ID with the submission and reuse it on retries.
        submission_id = UUID(data["submission_id"])
        name, email, message = data["name"], data["email"], data["message"]
    except (KeyError, TypeError, ValueError):
        return jsonify(error="Invalid contact form"), 400
    try:
        sent = mail.send(
            to="sales@bunevia.com", reply_to=email,
            subject=f"New enquiry from {name}", text=message,
            idempotency_key=f"contact:{submission_id}",
        )
    except UniMailError as exc:
        return jsonify(error=exc.code), 503
    return jsonify(message_id=sent.id, status=sent.status), 202

