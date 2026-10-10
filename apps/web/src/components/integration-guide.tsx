'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Copy } from 'lucide-react';
import { integrationExamples } from '@/lib/integration-examples';

export const integrationSections = ['Overview', 'Quick Start', 'New Project', 'Existing Project Migration', 'Contact Forms', 'Examples', 'Webhooks', 'Testing', 'Troubleshooting'] as const;
export type IntegrationSection = typeof integrationSections[number];

type Props = {
  section: IntegrationSection;
  onSectionChange: (section: IntegrationSection) => void;
  projectId: string;
  publicBaseUrl: string;
  hasCredential: boolean;
  senderGranted: boolean;
  senderEmail: string | null;
  mailboxId: string | null;
  copy: (value: string) => Promise<boolean>;
};

const errors: Array<[string, string, string]> = [
  ['API_KEY_INVALID', 'Missing or incorrect Bearer credential.', 'Check the private server environment and Authorization header.'],
  ['API_KEY_REVOKED', 'The key was revoked.', 'Create a replacement, update the application, then retire the old key.'],
  ['API_KEY_EXPIRED', 'The key reached its expiry.', 'Create a replacement credential.'],
  ['SENDER_NOT_AUTHORIZED', 'The mailbox is outside this key’s sender grants.', 'Grant this project mailbox to a new credential or select an authorized sender.'],
  ['RECIPIENT_SUPPRESSED', 'The recipient is suppressed for this project.', 'Review suppression and bounce history; do not bypass it in code.'],
  ['RATE_LIMIT_EXCEEDED', 'The key exceeded its request window.', 'Back off and retry the same logical request with the same idempotency key.'],
  ['IDEMPOTENCY_CONFLICT', 'The same key was used for different content.', 'Use one stable key per logical message and a new key for a new message.'],
];
const statuses = [
  ['QUEUED', 'Accepted by the API and waiting for the worker.'],
  ['PROCESSING', 'The worker is attempting delivery.'],
  ['RETRY_SCHEDULED', 'A retry is scheduled after a temporary failure.'],
  ['SMTP_ACCEPTED', 'The upstream SMTP server accepted the message.'],
  ['FAILED', 'Sending stopped; inspect Outgoing Mail for the failure code.'],
];

function CopyBlock({ value, label, copy }: { value: string; label: string; copy: (value: string) => Promise<boolean> }) {
  const [copied, setCopied] = useState('');
  return <div className="integration-guide-code"><pre>{value}</pre><button type="button" className="secondary-button" onClick={async () => { if (await copy(value)) setCopied(value); }} aria-label={'Copy ' + label}><Copy size={15}/> {copied === value ? 'Copied' : 'Copy ' + label}</button></div>;
}

export function IntegrationGuide({ section, onSectionChange, projectId, publicBaseUrl, hasCredential, senderGranted, senderEmail, mailboxId, copy }: Props) {
  const [example, setExample] = useState('Python');
  const endpoint = (publicBaseUrl || 'CONFIGURE_UNI_MAIL_HUB_API_URL') + '/api/v1/messages';
  const exampleRequest = JSON.stringify({
    fromMailboxId: mailboxId || 'MAILBOX_ID',
    to: [{ email: 'client@example.com', name: 'Client' }],
    subject: 'Hello', text: 'Hello from Uni Mail Hub', html: '<p>Hello from Uni Mail Hub</p>',
  }, null, 2);
  return <>
    <nav className="integration-guide-nav" aria-label="Integration guide sections">
      {integrationSections.map(item => <button key={item} type="button" className={section === item ? 'is-active' : ''} aria-current={section === item ? 'page' : undefined} onClick={() => onSectionChange(item)}>{item}</button>)}
    </nav>
    {section === 'Overview' && <section className="panel integration-card integration-guide">
      <h3>Direct REST API integration</h3>
      <p><strong>No Uni Mail Hub package is required.</strong> Your application&apos;s backend can call the Uni Mail Hub REST API directly.</p>
      <div className="integration-flow" aria-label="Sending path"><span>Your application backend</span><span>Uni Mail Hub REST API</span><span>Queue</span><span>SMTP worker</span><span>Configured mailbox / cPanel</span></div>
      <p>Uni Mail Hub centralizes SMTP credentials, sending, retry handling, logging, monitoring, bounce handling, and suppression. Your application keeps its API key server-side and makes an HTTP request when it needs to send.</p>
      <div className="integration-guide-alert"><strong>Environment variables alone are not enough.</strong> Your backend must call <code>POST /api/v1/messages</code>. It should not manage SMTP credentials.</div>
      <h4>One message, one request</h4>
      {!publicBaseUrl && <p>Set UNI_MAIL_HUB_PUBLIC_URL on the web server to show a deployable endpoint. A local API may use http://127.0.0.1:4000 when configured on that port.</p>}
      <CopyBlock value={endpoint} label="endpoint" copy={copy}/>
      <p>Use <code>Authorization: Bearer &lt;UNI_MAIL_HUB_API_KEY&gt;</code>, <code>Content-Type: application/json</code>, and <code>Idempotency-Key: &lt;unique-logical-request-id&gt;</code>.</p>
      <CopyBlock value={exampleRequest} label="JSON request" copy={copy}/>
      <p>A successful submission returns HTTP 202 and a queued message ID; it does not wait for SMTP delivery. Look up <code>GET /api/v1/messages/:id</code> using the same API key.</p>
      <div className="integration-status-list">{statuses.map(([status, meaning]) => <div key={status}><code>{status}</code><span>{meaning}</span></div>)}</div>
      <p><strong>SMTP_ACCEPTED</strong> means the upstream SMTP server accepted the message. It does not guarantee recipient Inbox placement.</p>
      <h4>Idempotency</h4><p>For example, use <code>bunevia-contact-9342</code> for one saved contact submission. Retry that same email with the same key to prevent duplicates. Generate a different key only for a different logical message.</p>
    </section>}
    {section === 'New Project' && <section className="panel integration-card integration-guide"><h3>Connect a new project</h3>
      <ol className="integration-checklist"><li>Create the project in Uni Mail Hub.</li><li>Add or select its domain.</li><li>Create or select a sender mailbox.</li><li>Test IMAP and SMTP on the mailbox page.</li><li>Create an application credential.</li><li>Grant only the sender mailboxes it needs.</li><li>Copy the URL, one-time API key, and mailbox ID into your backend environment.</li><li>Implement a server-side REST call to <code>POST /api/v1/messages</code>.</li><li>Send a synthetic test message to a controlled recipient.</li><li>Inspect Outgoing Mail until its status is <code>SMTP_ACCEPTED</code>, then verify receipt.</li></ol>
      <button type="button" className="secondary-button" onClick={() => onSectionChange('Quick Start')}>Open project setup</button>
    </section>}
    {section === 'Existing Project Migration' && <section className="panel integration-card integration-guide"><h3>Migrate an existing SMTP application</h3>
      <p>Import or discover the existing mailbox, provide its known credential or explicitly rotate it, then test IMAP and SMTP. Rotation can interrupt other clients using the old password.</p>
      <div className="integration-guide-columns"><div><h4>Old application settings</h4><pre>MAIL_HOST={"\n"}MAIL_PORT={"\n"}MAIL_USERNAME={"\n"}MAIL_PASSWORD=</pre></div><div><h4>New application settings</h4><pre>UNI_MAIL_HUB_URL={"\n"}UNI_MAIL_HUB_API_KEY={"\n"}UNI_MAIL_HUB_MAILBOX_ID=</pre></div></div>
      <ol className="integration-checklist"><li>Create a project API key and grant the imported sender mailbox.</li><li>Replace the old SMTP sending code with a backend REST request.</li><li>Send a controlled test and verify Outgoing Mail status and recipient receipt.</li><li>Remove old SMTP secrets after the new flow is verified.</li></ol>
      <div className="integration-guide-alert"><strong>Changing environment variables alone does not migrate the application.</strong> Its mail-sending code must also change.</div>
    </section>}
    {section === 'Contact Forms' && <section className="panel integration-card integration-guide"><h3>Send contact form messages</h3>
      <div className="integration-flow" aria-label="Contact form path"><span>Browser</span><span>Your application backend</span><span>Uni Mail Hub</span><span>SMTP</span></div>
      <p>Validate and save the submission in your backend, then call the API there. Never call Uni Mail Hub from browser JavaScript or a mobile app; that would expose the API key.</p>
      <div className="integration-guide-columns"><div><h4>From</h4><code>{senderEmail || 'contact@your-domain.example'}</code><p>Use a mailbox you control and have granted to the API key.</p></div><div><h4>Reply-To</h4><code>visitor@example.com</code><p>Set the visitor as Reply-To so staff can respond directly.</p></div></div>
      <p>Do not use the visitor&apos;s address as From. The authorized mailbox helps preserve SPF, DKIM, and DMARC alignment.</p>
      <p>Use the saved form submission ID as the idempotency key; repeat that key on retry. See the Python, Node.js, Next.js, and PHP examples.</p>
    </section>}
    {section === 'Examples' && <section className="panel integration-card integration-guide"><h3>Server-side REST examples</h3><p>Each example uses the same API contract. Replace the example recipient and validate all application input. No Uni Mail Hub SDK is needed.</p>
      <div className="integration-inline"><label>Language or framework<select value={example} onChange={event => setExample(event.target.value)}>{Object.keys(integrationExamples).map(name => <option key={name} value={name}>{name}</option>)}</select></label></div>
      <CopyBlock value={integrationExamples[example] || ''} label={example + ' example'} copy={copy}/>
      <p>For Next.js, use a Route Handler, Server Action, or backend service; never a Client Component. For NestJS, put the request in one reusable service. WordPress&apos;s example sends one application message and does not replace <code>wp_mail()</code> globally.</p>
    </section>}
    {section === 'Webhooks' && <section className="panel integration-card integration-guide"><h3>Optional webhooks</h3><p>Sending works without webhooks. Add them when your application needs asynchronous updates such as <code>mail.smtp_accepted</code>, <code>mail.failed</code>, <code>mail.bounced</code>, or <code>mail.received</code>.</p><p>Webhook signing secrets are separate from API keys. Configure endpoint URLs, events, and verification on the existing <Link href={'/projects/' + projectId + '?tab=Webhooks'}>Webhooks tab</Link>.</p></section>}
    {section === 'Testing' && <section className="panel integration-card integration-guide"><h3>Verify the integration</h3>
      <p>Use a controlled recipient and synthetic content. Keep the message ID returned by HTTP 202. Check Outgoing Mail and look up <code>GET /api/v1/messages/:id</code> with the same application key.</p>
      <div className="integration-status-list">
        <div><strong>{hasCredential ? 'Ready' : 'To do'}</strong><span>Application credential created {hasCredential ? '(verified here)' : ''}</span></div>
        <div><strong>{senderGranted ? 'Ready' : 'To do'}</strong><span>Selected sender granted {senderGranted ? '(verified here)' : ''}</span></div>
        {['Environment variables configured in your backend', 'Backend REST call implemented', 'Test message submitted', 'Outgoing Mail record exists', 'Status becomes SMTP_ACCEPTED', 'Controlled recipient receives message'].map(item => <div key={item}><strong>Check</strong><span>{item} (verify in your application or Outgoing Mail)</span></div>)}
      </div>
      <p>Use a new idempotency key for each new test message and reuse it if retrying the same one. If a status remains queued, verify the worker and queue. SMTP acceptance alone does not prove Inbox delivery.</p>
      <Link className="secondary-button" href="/outgoing-mail">Open Outgoing Mail</Link>
    </section>}
    {section === 'Troubleshooting' && <section className="panel integration-card integration-guide"><h3>Common errors</h3><div className="integration-error-table"><table><thead><tr><th>Code</th><th>Likely cause</th><th>Action</th></tr></thead><tbody>{errors.map(([code, cause, action]) => <tr key={code}><td><code>{code}</code></td><td>{cause}</td><td>{action}</td></tr>)}</tbody></table></div>
      <h4>Cannot connect to Uni Mail Hub</h4><p>Check the API base URL, that the API is running, firewall and network access, and the hostname visible from the application. On the same VPS, a host process may use <code>http://127.0.0.1:4000</code> if that is the configured API port. Inside Docker, <code>127.0.0.1</code> means the application container; use the reachable service or internal hostname instead. Use the configured HTTPS public URL where appropriate.</p>
      <h4>Security rules</h4><p>Keep the API key in the backend only. Never commit <code>.env</code>, expose it through <code>NEXT_PUBLIC_</code>, mobile code, or frontend bundles, or log the Authorization header. Use the granted mailbox as From and the visitor as Reply-To.</p>
    </section>}
  </>;
}
