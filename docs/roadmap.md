# Roadmap

1. **Foundation / Registry / Dashboard** — local stack, secure admin login, projects, domains, mailbox registry, health checks, worker scaffold, and truthful zero states.
2. **Sending API** — project-scoped hashed API keys, encrypted provider credentials, validated message submission, queues, SMTP worker, retries, and delivery events.
3. **IMAP synchronization and Webmail** — incremental sync, message persistence, attachment handling, threading, read views, and non-destructive mailbox actions.
4. **cPanel integration** — provider discovery, mailbox lifecycle integration, and safe credential rotation.
5. **Monitoring and DNS health** — live connection checks, SPF/DKIM/DMARC and MX checks, alerts, and operational metrics.
6. **Webhooks, bounce processing, templates, analytics, and advanced RBAC** — signed webhooks, delivery feedback, reusable templates, reporting, and scoped permissions.

Each phase should include migrations, threat review, tests, and migration-safe rollout before production use.
