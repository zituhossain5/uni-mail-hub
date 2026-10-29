# Dashboard appearance and motion

The dashboard uses the Lavender Soft concept. Color and motion preferences apply across the shared workspace layout.

Use the five color circles in the top bar to select Harbor, Lavender, Mint, Cloud, or Snow. The choice updates navigation, surfaces, buttons, and the mail-volume chart immediately. Preferences are saved in this browser and synchronized across its open tabs. When browser storage is unavailable, the controls still work for the current visit.

Open the sparkle button beside the colors for **Appearance & motion**. It includes a live preview and three modes:

| Mode | Behavior |
| --- | --- |
| Full motion | Cards enter in sequence and the chart draws on entry. Hover effects respond to interaction. Background gradients drift continuously, status dots breathe, service bars pulse, and an active processing icon rotates. |
| Subtle motion | Entrance and hover effects remain. Continuous decorative loops stop. |
| Motion off | Decorative animations and transitions stop. |

The operating system's reduced-motion setting takes precedence over all three modes. Animations use CSS transforms and opacity; they do not simulate data changes or automatically send mail. The Refresh dashboard button retrieves the latest workspace data.

Mail-volume ranges cover 7, 14, or 30 UTC calendar days and count outgoing messages by submission time. Hover or focus a chart point to read its value, or expand **View daily counts**. The chart and recent messages use the signed-in user's existing project and mailbox access. An empty period shows zero; a failed activity request shows an unavailable state. SMTP acceptance continues to mean upstream-server acceptance.

The change adds `GET /api/v1/dashboard/activity`. Release the API and web changes together. No database migration is needed.

Validation: `pnpm test:dashboard`, the existing role-access suite, web type checking, ESLint on changed files, and a production web build. Browser checks cover palettes, persistence, cross-tab updates, motion modes, chart interaction, 320px/390px navigation, viewer access, reduced motion, and hydration in the Asia/Dhaka timezone. Files in `output/dashboard-preview` use isolated sample data for visual review.
