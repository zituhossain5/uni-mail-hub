/** Check browser mutations against the configured site or a local dev tunnel. */
export function allowedRequestOrigin(
  request: Pick<Request, 'headers' | 'url'>,
  webUrl: string | undefined,
  environment: string | undefined,
): boolean {
  const origin = request.headers.get('origin');
  if (!origin || !webUrl) return false;

  try {
    const browser = new URL(origin);
    const configured = new URL(webUrl);
    if (browser.origin === configured.origin) return true;

    // SSH forwarding preserves the browser's Host, while Next.js may construct
    // request.url with its internal bind address and port. Match the actual Host
    // so another localhost site cannot make cross-origin authenticated requests.
    return environment === 'development'
      && ['localhost', '127.0.0.1', '[::1]'].includes(browser.hostname)
      && ['http:', 'https:'].includes(browser.protocol)
      && browser.origin === origin
      && browser.protocol === new URL(request.url).protocol
      && browser.host === request.headers.get('host')?.toLowerCase();
  } catch {
    return false;
  }
}
