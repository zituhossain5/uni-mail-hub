export const integrationExamples: Record<string, string> = {
  'Node.js': `import { randomUUID } from "node:crypto";
import { UniMail } from "@unicodeit/uni-mail";

const mail = new UniMail({
  baseUrl: process.env.UNI_MAIL_HUB_URL!,
  apiKey: process.env.UNI_MAIL_HUB_API_KEY!,
  mailboxId: process.env.UNI_MAIL_HUB_MAILBOX_ID!,
});
// SDK sends POST /api/v1/messages with Authorization: Bearer,
// Content-Type: application/json, and Idempotency-Key headers.
const result = await mail.send(
  { to: "client@example.com", subject: "Hello", html: "<p>Hello</p>" },
  { idempotencyKey: randomUUID() },
);
console.log(result.id, result.status);`,
  'Next.js': `// Server route only: app/api/notify/route.ts
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { UniMail } from "@unicodeit/uni-mail";

export async function POST() {
  const mail = new UniMail({
    baseUrl: process.env.UNI_MAIL_HUB_URL!,
    apiKey: process.env.UNI_MAIL_HUB_API_KEY!,
    mailboxId: process.env.UNI_MAIL_HUB_MAILBOX_ID!,
  });
  // SDK POSTs /api/v1/messages with Authorization: Bearer,
  // Idempotency-Key, and Content-Type: application/json headers.
  const sent = await mail.send(
    { to: "client@example.com", subject: "Hello", text: "Hello" },
    { idempotencyKey: randomUUID() },
  );
  return NextResponse.json({ id: sent.id, status: sent.status });
}`,
  NestJS: `import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { UniMail } from "@unicodeit/uni-mail";

@Injectable()
export class NotificationService {
  private readonly mail = new UniMail({
    baseUrl: process.env.UNI_MAIL_HUB_URL!,
    apiKey: process.env.UNI_MAIL_HUB_API_KEY!,
    mailboxId: process.env.UNI_MAIL_HUB_MAILBOX_ID!,
  });
  async sendHello(to: string) {
    // SDK POSTs /api/v1/messages with Authorization: Bearer,
    // Idempotency-Key, and Content-Type: application/json headers.
    return this.mail.send({ to, subject: "Hello", text: "Hello" }, {
      idempotencyKey: randomUUID(),
    });
  }
}`,
  PHP: `<?php
$url = rtrim((string) getenv('UNI_MAIL_HUB_URL'), '/') . '/api/v1/messages';
$key = (string) getenv('UNI_MAIL_HUB_API_KEY');
$mailboxId = (string) getenv('UNI_MAIL_HUB_MAILBOX_ID');
$payload = json_encode([
    'fromMailboxId' => $mailboxId,
    'to' => [['email' => 'client@example.com']],
    'subject' => 'Hello',
    'text' => 'Hello',
], JSON_THROW_ON_ERROR);
$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => [
        'Authorization: Bearer ' . $key,
        'Idempotency-Key: ' . bin2hex(random_bytes(16)),
        'Content-Type: application/json',
    ],
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 15,
]);
$body = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
curl_close($ch);
if ($body === false || $status < 200 || $status >= 300) {
    throw new RuntimeException('Uni Mail Hub send failed (HTTP ' . $status . ')');
}
$result = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
`,
  Laravel: `// config/services.php: 'uni_mail_hub' => [
//   'url' => env('UNI_MAIL_HUB_URL'),
//   'key' => env('UNI_MAIL_HUB_API_KEY'),
//   'mailbox' => env('UNI_MAIL_HUB_MAILBOX_ID'),
// ],
use Illuminate\\Support\\Facades\\Http;
use Illuminate\\Support\\Str;

$result = Http::withToken(config('services.uni_mail_hub.key'))
    ->withHeaders([
        'Idempotency-Key' => (string) Str::uuid(),
        'Content-Type' => 'application/json',
    ])
    ->acceptJson()
    ->post(rtrim(config('services.uni_mail_hub.url'), '/') . '/api/v1/messages', [
        'fromMailboxId' => config('services.uni_mail_hub.mailbox'),
        'to' => [['email' => 'client@example.com']],
        'subject' => 'Hello',
        'text' => 'Hello',
    ])->throw()->json();`,
  WordPress: `<?php
// Define UNI_MAIL_HUB_URL, UNI_MAIL_HUB_API_KEY, and
// UNI_MAIL_HUB_MAILBOX_ID in server config or wp-config.php.
// This sends one application message; it does not replace wp_mail().
$response = wp_remote_post(UNI_MAIL_HUB_URL . '/api/v1/messages', [
    'timeout' => 15,
    'headers' => [
        'Authorization' => 'Bearer ' . UNI_MAIL_HUB_API_KEY,
        'Idempotency-Key' => wp_generate_uuid4(),
        'Content-Type' => 'application/json',
    ],
    'body' => wp_json_encode([
        'fromMailboxId' => UNI_MAIL_HUB_MAILBOX_ID,
        'to' => [['email' => 'client@example.com']],
        'subject' => 'Hello',
        'text' => 'Hello',
    ]),
]);
if (is_wp_error($response) || wp_remote_retrieve_response_code($response) >= 300) {
    throw new RuntimeException('Uni Mail Hub send failed');
}`,
  cURL: `# Set UNI_MAIL_HUB_URL, UNI_MAIL_HUB_API_KEY, and
# UNI_MAIL_HUB_MAILBOX_ID in your shell environment first.
curl --fail-with-body --silent --show-error \\
  -X POST "$UNI_MAIL_HUB_URL/api/v1/messages" \\
  -H "Authorization: Bearer $UNI_MAIL_HUB_API_KEY" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d "{\\"fromMailboxId\\":\\"$UNI_MAIL_HUB_MAILBOX_ID\\",\\"to\\":[{\\"email\\":\\"client@example.com\\"}],\\"subject\\":\\"Hello\\",\\"text\\":\\"Hello\\"}"`,
  PowerShell: `$body = @{
  fromMailboxId = $env:UNI_MAIL_HUB_MAILBOX_ID
  to = @(@{ email = 'client@example.com' })
  subject = 'Hello'
  text = 'Hello'
} | ConvertTo-Json -Depth 5
$headers = @{
    Authorization = "Bearer $($env:UNI_MAIL_HUB_API_KEY)"
    'Idempotency-Key' = [guid]::NewGuid().ToString()
    'Content-Type' = 'application/json'
}
Invoke-RestMethod -Method Post -Uri "$($env:UNI_MAIL_HUB_URL)/api/v1/messages" -Headers $headers -Body $body`,
  Python: `# pip install -e D:\\projects\\uni-mail-hub\\clients\\python
# Set UNI_MAIL_HUB_URL, UNI_MAIL_HUB_API_KEY, UNI_MAIL_HUB_MAILBOX_ID
# in the Python server environment, not frontend code.
from uni_mail import UniMail

# The SDK sends POST /api/v1/messages with Authorization: Bearer,
# Idempotency-Key, and Content-Type: application/json headers.
with UniMail.from_env() as mail:
    sent = mail.send(
        to="client@example.com", subject="Hello", text="Hello",
        idempotency_key="submission-123",  # reuse on retry
    )
    status = mail.get_message(sent.id)`,
  FastAPI: `# Server-side FastAPI lifespan: reuse one async mail client.
# UNI_MAIL_HUB_URL, UNI_MAIL_HUB_API_KEY, UNI_MAIL_HUB_MAILBOX_ID
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request
from uni_mail import AsyncUniMail, UniMailError

@asynccontextmanager
async def lifespan(app: FastAPI):
    async with AsyncUniMail.from_env() as mail:
        app.state.mail = mail
        yield

app = FastAPI(lifespan=lifespan)

@app.post("/contact", status_code=202)
async def contact(request: Request):
    data = await request.json()  # validate and persist a submission first
    try:
        # SDK: POST /api/v1/messages, Authorization: Bearer,
        # Idempotency-Key, Content-Type: application/json
        sent = await request.app.state.mail.send(
            to="sales@example.com", reply_to=data["email"],
            subject="New contact", text=data["message"],
            idempotency_key=f"contact:{data['submission_id']}",
        )
    except UniMailError as exc:
        raise HTTPException(status_code=503, detail=exc.code) from None
    return {"message_id": sent.id}`,
  Django: `# Server-side Django view; configure UNI_MAIL_HUB_URL,
# UNI_MAIL_HUB_API_KEY, UNI_MAIL_HUB_MAILBOX_ID in the server environment.
from django.http import JsonResponse
from uni_mail import UniMail, UniMailError

mail = UniMail.from_env()  # reuse per worker

def contact(request):
    form = ContactForm(request.POST)  # validate and persist a submission
    if not form.is_valid():
        return JsonResponse({"error": "Invalid form"}, status=400)
    data = form.cleaned_data
    try:
        # SDK: POST /api/v1/messages, Authorization: Bearer,
        # Idempotency-Key, Content-Type: application/json
        sent = mail.send(
            to="sales@example.com", reply_to=data["email"],
            subject="New contact", text=data["message"],
            idempotency_key=f"contact:{data['submission_id']}",
        )
    except UniMailError as exc:
        return JsonResponse({"error": exc.code}, status=503)
    return JsonResponse({"message_id": sent.id}, status=202)`,
  Flask: `# Server-side Flask route; configure UNI_MAIL_HUB_URL,
# UNI_MAIL_HUB_API_KEY, UNI_MAIL_HUB_MAILBOX_ID in the server environment.
from flask import Flask, jsonify, request
from uni_mail import UniMail, UniMailError

app = Flask(__name__)
mail = UniMail.from_env()  # reuse per worker

@app.post("/contact")
def contact():
    data = request.get_json()  # validate and persist a submission first
    try:
        # SDK: POST /api/v1/messages, Authorization: Bearer,
        # Idempotency-Key, Content-Type: application/json
        sent = mail.send(
            to="sales@example.com", reply_to=data["email"],
            subject="New contact", text=data["message"],
            idempotency_key=f"contact:{data['submission_id']}",
        )
    except UniMailError as exc:
        return jsonify(error=exc.code), 503
    return jsonify(message_id=sent.id), 202`,
};
