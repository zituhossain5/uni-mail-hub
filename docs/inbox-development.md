# Inbox design development server

The inbox redesign runs at **http://144.91.77.61:4395/inbox**. This is a Next.js development server with Fast Refresh, separate from the production Docker deployment. Source edits appear here without a production build or release.

Sign in with your usual **live Uni Mail Hub account**. The former sample login no longer applies. This frontend has its own browser session at the IP address. An old sample session redirects back to sign-in. The ignored `.env.inbox-preview` contains only dev runtime configuration and is owned by `zitu` with mode `600`; it contains no production passwords or database credentials.

## Local access through SSH

Forward a local port to the development frontend, for example:

```sh
ssh -N -L 1337:127.0.0.1:4395 YOUR_SSH_HOST
```

Open `http://localhost:1337/login` and use your usual live account. The local port can differ from the server port. In development, the API relay accepts loopback origins (`localhost`, `127.0.0.1`, and `[::1]`) only when the browser Origin matches the incoming Host and protocol. This supports SSH forwarding even when Next.js constructs its internal request URL with the server's bind address. Cross-origin local requests are rejected. Production continues to require the configured `WEB_URL` origin.

## Editing

- `apps/web/src/components/webmail.tsx`: mailbox heading, folders, conversation list, search, filters, and reader.
- `apps/web/src/app/inbox.css`: inbox layout, theme colors, responsive views, and decorative motion.
- `apps/web/src/components/webmail-compose.tsx` and `webmail-response.tsx`: compose and reply dialogs.
- `apps/web/src/components/mail-rich-editor.tsx`, `apps/web/src/lib/composer-html.ts`, and `apps/web/src/app/composer.css`: rich composition, clipboard normalization, and email HTML serialization.
- `scripts/dev/live-api-proxy.mjs` and `docker-compose.inbox-dev.yml`: the private bridge to the existing live API.
- `scripts/dev/inbox-preview.mjs`: the previous sample backend, retained for reference and stopped.

The inbox follows all five existing workspace palettes. Full motion includes the quiet empty-state float and sync indicator pulse; Subtle and Off stop those continuous effects. Device reduced-motion settings are respected.

Search and the All mail / Unread / Flagged / Files filters apply to **loaded conversations**. Load more to include the next page. Newest/oldest ordering is also local to that loaded list. The reader preserves the existing reply, forwarding, recipient details, attachments, remote image protection, and message action flows.

## Rich composition

Compose uses a lazy-loaded Tiptap editor with headings, fonts, sizes, text/highlight colors, alignment, lists, indentation, quotes, links, hosted images, and editable tables. Standard paste keeps supported formatting, including clipboard CSS classes and common Word list markup. A plain-text paste option removes source formatting. HTML source editing, sandboxed preview, undo/redo, and an expanded writing view are available.

On submission, the editor produces inline-styled HTML plus a readable plain-text alternative for the existing live compose endpoint. HTML is normalized before previewing and sending; scripts, event handlers, unsafe URLs, and unsupported active content are removed. Images can use hosted HTTP(S) URLs, pasted image files, embedded data images, or the image picker. Files can be attached or dropped into the message. The live backend now supports pasted images and attached files through **Send message**. These sends affect the real selected mailbox and recipients. Closing and reopening Compose refreshes attachment capabilities after the rollout. The local **Download test email** action is retained as a fallback for older or unavailable backends. See [Compose images and attachments](compose-attachments.md) for limits, backend source changes, and review behavior.

Closing and reopening Compose retains its current draft in memory on that page. Reloading or navigating away does not save it as a server-side draft.

Browser validation in `output/composer-preview/` uses synthetic mailbox data and intercepts every browser API request. The send check captures the outgoing payload and returns a simulated failure so no test message reaches the live queue. A temporary authenticated test session was signed out after the checks. Tests cover formatting retention, table editing, HTML/preview round trips, safe markup cleanup, cursor insertion, a 200-paragraph paste with one-step undo/redo, draft retention, and desktop/mobile layouts.

## Live backend connection

The web server listens on `0.0.0.0:4395` and proxies API requests through `http://127.0.0.1:4396`. That loopback port belongs to the separate `uni-mail-hub-inbox-dev-live-api-proxy-1` container on the existing `uni-mail-hub_front` network. The bridge forwards to `http://uni-mail-hub-api:4000` using Docker DNS, so replacement of the live API container does not require hardcoding a new container IP.

This is the real live backend, database, and mail queue. Your normal role and permissions apply. Opening a message may mark it read, and sending, replying, flagging, moving, archiving, deleting, or synchronizing mail affects the live mailbox. The app displays **Dev design · Live mail** to make this clear. No production credentials are copied into the bridge.

The public production website still uses its existing image and design. No production containers, releases, routes, or database schemas were changed or restarted to connect this dev frontend. Only the dev frontend and its separate private API bridge were changed.

The banner requires `INBOX_DESIGN_PREVIEW=1`, `INBOX_PREVIEW_BACKEND=live`, and `NODE_ENV=development`. Normal production builds do not show it.

## Running services

The enabled `uni-mail-hub-inbox-preview-web` systemd service keeps Next.js running with Fast Refresh. The private API bridge has Docker's `unless-stopped` restart policy. Both survive terminal closure and host reboot. The former sample API systemd service is **stopped and disabled**.

```sh
systemctl status uni-mail-hub-inbox-preview-web
journalctl -u uni-mail-hub-inbox-preview-web -n 50 --no-pager
docker compose --env-file .env.inbox-preview -f docker-compose.inbox-dev.yml ps
```

The bridge reuses an installed Node runtime image selected by `INBOX_DEV_PROXY_IMAGE`. It runs only the small forwarding script; no application build or production release is involved.

Web source edits refresh automatically. To restart just the dev frontend:

```sh
sudo systemctl restart uni-mail-hub-inbox-preview-web
```

To recreate the dev bridge after changing its script or compose configuration:

```sh
docker compose --env-file .env.inbox-preview -f docker-compose.inbox-dev.yml up -d --pull never --no-build --force-recreate
```

To stop only this development environment:

```sh
sudo systemctl stop uni-mail-hub-inbox-preview-web
docker compose --env-file .env.inbox-preview -f docker-compose.inbox-dev.yml down
```

Do not start the old sample backend on port 4396 while the live bridge is running. Its old configuration is retained privately in `.env.inbox-preview.sample` as a historical backup.

## Validation

TypeScript and ESLint cover the edited UI and bridge. Connection checks verify the existing live API's health through the loopback bridge and through the dev frontend's normal relay, enforce sign-in for mail requests, and confirm the old sample session is rejected. These checks do not open real messages, send mail, or create a live login session. Final authenticated mailbox review uses your normal live login.

The earlier screenshots and full inbox interaction report in `output/inbox-preview/` used the former sample backend. They remain design validation artifacts; `live-backend-validation.json` records the subsequent switch to the live API. The earlier mutating sample-data browser scripts are guarded against running in live-backend mode.
