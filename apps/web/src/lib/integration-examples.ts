// All examples call the REST API from a server. A retry of the same logical
// send must reuse its original Idempotency-Key.
export const integrationExamples: Record<string, string> = {
  'Node.js': `// Node 18+ backend; no Uni Mail Hub package required.
const response = await fetch(process.env.UNI_MAIL_HUB_URL + '/api/v1/messages', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + process.env.UNI_MAIL_HUB_API_KEY,
    'Content-Type': 'application/json',
    'Idempotency-Key': 'contact-' + submission.id,
  },
  body: JSON.stringify({
    fromMailboxId: process.env.UNI_MAIL_HUB_MAILBOX_ID,
    to: [{ email: 'sales@example.com' }],
    replyTo: { email: submission.email },
    subject: 'New website enquiry', text: submission.message,
  }),
  signal: AbortSignal.timeout(10000),
});
if (!response.ok) throw new Error('Mail API HTTP ' + response.status);
const queued = await response.json(); // Save queued.id for status lookup.`,
  'Next.js': `// app/api/contact/route.ts (server Route Handler). Validate and persist first.
import { NextResponse } from 'next/server';
export async function POST(request: Request) {
  const submission = await request.json(); // replace with validated, saved input
  const response = await fetch(process.env.UNI_MAIL_HUB_URL + '/api/v1/messages', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.UNI_MAIL_HUB_API_KEY,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'contact-' + submission.id,
    },
    body: JSON.stringify({
      fromMailboxId: process.env.UNI_MAIL_HUB_MAILBOX_ID,
      to: [{ email: 'sales@example.com' }],
      replyTo: { email: submission.email },
      subject: 'New website enquiry', text: submission.message,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return NextResponse.json({ error: 'Mail submission failed' }, { status: 502 });
  return NextResponse.json(await response.json(), { status: 202 });
}
// Never put the key in NEXT_PUBLIC_ variables or a Client Component.`,
  NestJS: `import { Injectable } from '@nestjs/common';
@Injectable()
export class MailService {
  async sendContact(submission: { id: string; email: string; message: string }) {
    const response = await fetch(process.env.UNI_MAIL_HUB_URL + '/api/v1/messages', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.UNI_MAIL_HUB_API_KEY,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'contact-' + submission.id,
      },
      body: JSON.stringify({
        fromMailboxId: process.env.UNI_MAIL_HUB_MAILBOX_ID,
        to: [{ email: 'sales@example.com' }],
        replyTo: { email: submission.email },
        subject: 'New website enquiry', text: submission.message,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Mail API HTTP ' + response.status);
    return response.json();
  }
}`,
  PHP: `<?php
$payload = json_encode([
    'fromMailboxId' => getenv('UNI_MAIL_HUB_MAILBOX_ID'),
    'to' => [['email' => 'sales@example.com']],
    'replyTo' => ['email' => $submission['email']],
    'subject' => 'New website enquiry', 'text' => $submission['message'],
], JSON_THROW_ON_ERROR);
$ch = curl_init(rtrim(getenv('UNI_MAIL_HUB_URL'), '/') . '/api/v1/messages');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => [
        'Authorization: Bearer ' . getenv('UNI_MAIL_HUB_API_KEY'),
        'Content-Type: application/json',
        'Idempotency-Key: contact-' . $submission['id'],
    ],
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 10,
]);
$body = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
if ($body === false || $status < 200 || $status >= 300) {
    throw new RuntimeException('Mail API HTTP ' . $status);
}
$queued = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
curl_close($ch);`,
  Laravel: `// config/services.php: 'uni_mail_hub' => [
//   'url' => env('UNI_MAIL_HUB_URL'), 'key' => env('UNI_MAIL_HUB_API_KEY'),
//   'mailbox' => env('UNI_MAIL_HUB_MAILBOX_ID'),
// ],
use Illuminate\\Support\\Facades\\Http;
$queued = Http::withToken(config('services.uni_mail_hub.key'))
    ->acceptJson()
    ->withHeaders(['Idempotency-Key' => 'contact-' . $submission->id,
                   'Content-Type' => 'application/json'])
    ->timeout(10)
    ->post(rtrim(config('services.uni_mail_hub.url'), '/') . '/api/v1/messages', [
        'fromMailboxId' => config('services.uni_mail_hub.mailbox'),
        'to' => [['email' => 'sales@example.com']],
        'replyTo' => ['email' => $submission->email],
        'subject' => 'New website enquiry', 'text' => $submission->message,
    ])->throw()->json();`,
  WordPress: `<?php
// Define UNI_MAIL_HUB_* in private server configuration.
// This does not globally replace wp_mail().
$response = wp_remote_post(rtrim(UNI_MAIL_HUB_URL, '/') . '/api/v1/messages', [
    'timeout' => 10,
    'headers' => [
        'Authorization' => 'Bearer ' . UNI_MAIL_HUB_API_KEY,
        'Content-Type' => 'application/json',
        'Idempotency-Key' => 'contact-' . $submission_id,
    ],
    'body' => wp_json_encode([
        'fromMailboxId' => UNI_MAIL_HUB_MAILBOX_ID,
        'to' => [['email' => 'sales@example.com']],
        'replyTo' => ['email' => $visitor_email],
        'subject' => 'New website enquiry', 'text' => $message,
    ]),
]);
if (is_wp_error($response) || wp_remote_retrieve_response_code($response) >= 300) {
    throw new RuntimeException('Mail API submission failed');
}`,
  cURL: `# Set UNI_MAIL_HUB_URL, UNI_MAIL_HUB_API_KEY and UNI_MAIL_HUB_MAILBOX_ID
# in your private shell environment. Reuse this key if retrying this send.
curl --fail-with-body --silent --show-error \\
  -X POST "$UNI_MAIL_HUB_URL/api/v1/messages" \\
  -H "Authorization: Bearer $UNI_MAIL_HUB_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: test-$(uuidgen)" \\
  -d "{\\"fromMailboxId\\":\\"$UNI_MAIL_HUB_MAILBOX_ID\\",\\"to\\":[{\\"email\\":\\"controlled@example.com\\"}],\\"subject\\":\\"Integration test\\",\\"text\\":\\"Synthetic test content.\\"}"`,
  PowerShell: `$body = @{
  fromMailboxId = $env:UNI_MAIL_HUB_MAILBOX_ID
  to = @(@{ email = 'controlled@example.com' })
  subject = 'Integration test'
  text = 'Synthetic test content.'
} | ConvertTo-Json -Depth 5
$headers = @{
  Authorization = "Bearer $($env:UNI_MAIL_HUB_API_KEY)"
  'Idempotency-Key' = 'test-' + [guid]::NewGuid().ToString()
  'Content-Type' = 'application/json'
}
$queued = Invoke-RestMethod -Method Post -Uri "$($env:UNI_MAIL_HUB_URL)/api/v1/messages" -Headers $headers -Body $body
$queued # Save ID and reuse the key on retry.`,
  Python: `# pip install httpx; no Uni Mail Hub package required.
import os
import httpx

def send_contact(submission):
    response = httpx.post(
        os.environ['UNI_MAIL_HUB_URL'].rstrip('/') + '/api/v1/messages',
        headers={
            'Authorization': 'Bearer ' + os.environ['UNI_MAIL_HUB_API_KEY'],
            'Content-Type': 'application/json',
            'Idempotency-Key': 'contact-' + str(submission['id']),
        },
        json={
            'fromMailboxId': os.environ['UNI_MAIL_HUB_MAILBOX_ID'],
            'to': [{'email': 'sales@example.com'}],
            'replyTo': {'email': submission['email']},
            'subject': 'New website enquiry', 'text': submission['message'],
        },
        timeout=10,
    )
    response.raise_for_status()
    return response.json()`,
  FastAPI: `# Server-side FastAPI; pip install httpx. Reuse a client per app lifespan.
import os
import httpx
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request

@asynccontextmanager
async def lifespan(app: FastAPI):
    async with httpx.AsyncClient(timeout=10) as client:
        app.state.mail_http = client
        yield

app = FastAPI(lifespan=lifespan)

@app.post('/contact', status_code=202)
async def contact(submission: dict, request: Request):  # validate and persist first
    response = await request.app.state.mail_http.post(
        os.environ['UNI_MAIL_HUB_URL'].rstrip('/') + '/api/v1/messages',
        headers={'Authorization': 'Bearer ' + os.environ['UNI_MAIL_HUB_API_KEY'],
                 'Content-Type': 'application/json',
                 'Idempotency-Key': 'contact-' + str(submission['id'])},
        json={'fromMailboxId': os.environ['UNI_MAIL_HUB_MAILBOX_ID'],
              'to': [{'email': 'sales@example.com'}],
              'replyTo': {'email': submission['email']},
              'subject': 'New website enquiry', 'text': submission['message']},
    )
    if response.is_error:
        raise HTTPException(status_code=502, detail='Mail submission failed')
    return response.json()`,
  Django: `# Server-side Django view; pip install httpx.
import os
import httpx
from django.http import JsonResponse

def contact(request):
    submission = save_validated_contact(request)  # your application function
    response = httpx.post(
        os.environ['UNI_MAIL_HUB_URL'].rstrip('/') + '/api/v1/messages',
        headers={'Authorization': 'Bearer ' + os.environ['UNI_MAIL_HUB_API_KEY'],
                 'Content-Type': 'application/json',
                 'Idempotency-Key': 'contact-' + str(submission.id)},
        json={'fromMailboxId': os.environ['UNI_MAIL_HUB_MAILBOX_ID'],
              'to': [{'email': 'sales@example.com'}],
              'replyTo': {'email': submission.email},
              'subject': 'New website enquiry', 'text': submission.message},
        timeout=10,
    )
    if response.is_error:
        return JsonResponse({'error': 'Mail submission failed'}, status=502)
    return JsonResponse(response.json(), status=202)`,
  Flask: `# Server-side Flask route; pip install httpx.
import os
import httpx
from flask import Flask, jsonify, request
app = Flask(__name__)

@app.post('/contact')
def contact():
    submission = save_validated_contact(request.get_json())  # your function
    response = httpx.post(
        os.environ['UNI_MAIL_HUB_URL'].rstrip('/') + '/api/v1/messages',
        headers={'Authorization': 'Bearer ' + os.environ['UNI_MAIL_HUB_API_KEY'],
                 'Content-Type': 'application/json',
                 'Idempotency-Key': 'contact-' + str(submission.id)},
        json={'fromMailboxId': os.environ['UNI_MAIL_HUB_MAILBOX_ID'],
              'to': [{'email': 'sales@example.com'}],
              'replyTo': {'email': submission.email},
              'subject': 'New website enquiry', 'text': submission.message},
        timeout=10,
    )
    if response.is_error:
        return jsonify(error='Mail submission failed'), 502
    return jsonify(response.json()), 202)`,
};
