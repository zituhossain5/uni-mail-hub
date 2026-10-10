"""Concise Django server-side form pattern; no Django SMTP backend needed."""

from django import forms
from django.http import JsonResponse
from django.views.decorators.http import require_POST
from uni_mail import UniMail, UniMailError


class ContactForm(forms.Form):
    # Persist this ID with the submission; preserve it across retries.
    submission_id = forms.UUIDField()
    name = forms.CharField(max_length=120)
    email = forms.EmailField()
    message = forms.CharField()


# Reuse one HTTP connection pool per Django worker process.
mail = UniMail.from_env()


@require_POST
def contact(request):
    form = ContactForm(request.POST)
    if not form.is_valid():
        return JsonResponse({"error": "Invalid contact form"}, status=400)
    data = form.cleaned_data
    try:
        sent = mail.send(
            to="sales@bunevia.com", reply_to=data["email"],
            subject=f"New enquiry from {data['name']}", text=data["message"],
            idempotency_key=f"contact:{data['submission_id']}",
        )
    except UniMailError as exc:
        return JsonResponse({"error": exc.code}, status=503)
    return JsonResponse({"message_id": sent.id, "status": sent.status}, status=202)

