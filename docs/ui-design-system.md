# Uni Mail Hub UI foundation

The web app keeps its light, information-focused interface. `apps/web/src/app/globals.css` contains the original styles; `polish.css` defines the shared surface, spacing, interaction, and responsive rules used by Modules 1–3. The project uses Inter/system sans for interface text and system monospace for API keys, IDs, and SMTP codes. It does not require another component or icon package.

## Tokens and hierarchy

- Brand: blue `#2563EB`, indigo `#4F46E5`, cyan `#06B6D4`. Use the gradient for the logo/login art; operational controls use solid blue.
- Background `#F8FAFC`, surface `#FFFFFF`, border `#E2E8F0`, text `#0F172A`, muted text `#64748B`.
- Semantic status colors: green for accepted/healthy, amber for warning/retry, red for failure/revocation, blue for queued/processing, gray for unknown/disabled. `StatusBadge` always pairs color with text and a dot.
- Page headings use an eyebrow, title, description, optional status, and actions through `PageHeader`. `SectionCard` provides the shared card header and padded body. `DetailField` gives labels and values a consistent scanning pattern.
- The main content is capped at 1460px; detail pages are capped at 1280px. Spacing steps are roughly 8, 12, 16, 20, 24, and 32px. Desktop content padding scales up to 40px, tablet uses 22px, and mobile uses 16px.

## Controls and states

- Primary buttons are solid blue. Secondary buttons have a subtle border. Ghost buttons handle low-emphasis row actions; destructive confirmation uses red. Controls share a minimum 38px height and visible focus rings.
- `Dialog` uses the native modal dialog top layer, initial focus handling, Escape behavior, and focus containment. Headers and action footers remain visible while long form content scrolls. `ConfirmDialog` is used for deletion, credential removal, key revocation, and manual retry.
- The API-key secret display uses a monospace code panel with safe wrapping, integrated Copy action, copy feedback, and an explicit completion button. Its raw value stays only in component state and is cleared on close.
- `EmptyState` explains the next action. Lists show loading and error states; async buttons show a busy label and disable repeated submission. Tables have semantic column headers, consistent cell padding, truncation with a title for long values, and horizontal scrolling on narrow screens.
- `DateTime` renders the same short/full date style across lists and detail pages, with the exact timestamp available as a title on short dates.

## Responsive and accessibility rules

- At 850px and below the sidebar becomes a hidden off-canvas navigation panel. The menu button opens it; Escape or Close returns focus to the trigger. The account popup closes on Escape or outside pointer input.
- Detail grids stack on tablet and mobile. Form grids and protocol health cards stack on mobile. Tables scroll within cards instead of widening the document. Dialog width is bounded by the viewport and height by 88vh.
- The shell has a skip-to-content link. Interactive controls have visible keyboard focus, dialogs have accessible names, forms use labels, and status does not depend on color alone. Motion is reduced when `prefers-reduced-motion` is active.

The routes under `apps/web/src/app/(protected)` use these shared components from `apps/web/src/components/ui.tsx` and `dialog.tsx`. Placeholder routes remain clearly marked as future work; this UI pass adds no Module 4 functionality.
