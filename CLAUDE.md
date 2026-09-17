# CLAUDE.md

This file defines mandatory rules for Claude when working in this repository. These rules apply to every task unless I explicitly override a specific rule.

# 1. Core Working Rule

Do not treat a request as permission to immediately write code.

Before any meaningful change:
1. Inspect the existing implementation.
2. Understand architecture, dependencies, permissions, data scope, APIs, models, frontend usage, tests, and side effects.
3. Search for an existing implementation that can be reused or extended.
4. Plan the smallest safe change.
5. Implement only after the above is understood.

Never create a second implementation simply because it is easier than understanding the existing one.

# 2. Project Boundary

Work only inside this repository/project.

Never:
- Access, read, modify, or copy code from another project.
- Access or modify another project's database or `.env`.
- Modify unrelated repositories or global system configuration.
- Deploy or make live-server changes unless explicitly approved.

If something requires access outside this project, stop and report it.

# 3. No Duplicate Sources of Truth

Reuse or refactor existing models, tables, services, APIs, utilities, components, hooks, stores, settings, validation, permissions, constants, schedule engines, pricing engines, and booking logic.

There must be one authoritative source for each business rule.

Do not duplicate logic across:
- Frontend and backend
- Multiple APIs
- Different modules
- Organization, Club, and Facility implementations

The backend is authoritative for business-critical logic.

# 4. Architecture and Code Quality

Follow the existing project architecture and conventions unless there is a strong reason not to.

Code must be:
- Clear
- Maintainable
- Modular
- Testable
- Secure
- Predictable
- Easy for another developer to understand

Prefer simple, explicit solutions over clever or over-engineered abstractions.

Keep responsibilities separated. Complex business logic should not live directly in React presentation components, views, or serializers when the project already uses services/hooks for those concerns.

Use meaningful names. Avoid vague names such as `data`, `temp`, `obj`, or `result2` when a clearer name is possible.

Comments should explain why, constraints, business rules, or security reasoning, not obvious code behavior.

# 5. Security Is Mandatory

Never bypass or weaken:
- Authentication
- Authorization
- Roles and permissions
- Object-level permissions
- Organization / Club / Facility isolation
- Ownership checks
- CSRF / CORS protections
- Input validation
- Rate limiting
- File validation
- Audit requirements

Frontend permission checks are UX only. Protected actions must be enforced by the backend.

Treat all client input as untrusted. Validate IDs, foreign keys, dates, times, amounts, statuses, files, query parameters, and scope server-side.

# 6. Data Isolation

Always maintain correct boundaries between:
- Organization
- Club
- Facility
- User
- Customer
- Booking

Never trust frontend-provided IDs without validating ownership and permission scope.

Every query must be reviewed for correct tenant/scope filtering.

# 7. Secrets and Environment Safety

Never hard-code or expose:
- API keys
- Passwords
- Tokens
- Secret keys
- SMTP credentials
- Cloud credentials
- Database credentials

Use environment variables.

Never expose `.env` values in logs, responses, screenshots, docs, or frontend bundles.

Do not modify production/server `.env` without explicit confirmation.

For new environment variables, document name, purpose, and example format only.

# 8. Git Safety

Never perform Git write operations without explicit confirmation for that specific action, including:
- commit
- push
- merge
- rebase
- reset
- cherry-pick
- revert
- branch deletion
- force push
- tag creation
- history rewriting

Read-only commands such as `git status`, `git diff`, `git log`, `git branch`, and `git show` are allowed when needed.

Before any approved commit, review staged files and ensure no secrets, `.env`, database dumps, generated reports, uploads, virtual environments, `node_modules`, build outputs, caches, or IDE files are included.

# 9. Database and Migration Safety

Never perform destructive database actions without explicit confirmation.

Do not:
- Drop databases or tables
- Truncate tables
- Reset production data
- Run destructive SQL
- Modify production records manually

Before model/schema changes:
- Inspect existing models and relationships.
- Inspect migration history.
- Check existing data assumptions.
- Check API/frontend dependencies.
- Reuse existing schema where practical.

Never run production migrations without explicit confirmation.
Never casually edit applied migrations or rewrite migration history.

Use database constraints where appropriate: foreign keys, unique constraints, checks, and non-null constraints.

# 10. Server Protection

Never without explicit confirmation:
- Deploy to production
- Restart production services/containers
- Modify Nginx, Apache, systemd, DNS, firewall, or production dependencies
- Modify production environment variables
- Run production migrations

# 11. Backend Is Authoritative

Business-critical rules must be enforced in the backend, including:
- Availability
- Booking validation
- Pricing
- Promo eligibility
- Subscription/package entitlement
- Payment validation
- Conflict detection
- Status transitions
- Permission checks
- Facility access
- Schedule resolution

Frontend logic may assist UX but must not be the only enforcement layer.

# 12. Availability Authority

Facility availability is the authoritative gate for every booking flow.

Business hours, holidays, special-date schedules, breaks, closures, maintenance blocks, and existing bookings determine whether a slot is available.

Pricing rules, promo codes, subscriptions, memberships, packages, and credits may affect price or entitlement only. They must never create or bypass unavailable slots.

Every booking entry point must use the same backend availability engine and revalidate availability immediately before saving.

Do not trust a slot simply because it appeared available earlier.

# 13. Concurrency and Transaction Safety

Use transactions for operations that must succeed or fail together, especially:
- Booking creation
- Payment + booking update
- Slot reservation
- Multi-record status changes
- Resource allocation

Prevent double booking and race conditions. Revalidate availability before final creation and use locking/constraints where appropriate.

# 14. Date, Time, and Money

Use timezone-aware datetimes. Do not treat browser time as authoritative.

Use configured Organization/Club timezone where applicable. Handle overnight schedules, date boundaries, UTC conversion, and DST where relevant.

Never use floating-point arithmetic for money. Use Decimal/proper monetary fields and consistent rounding, tax, discount, refund, and currency handling.

# 15. APIs, Queries, and Performance

APIs must be consistent, validated, permission-protected, and backward-compatible where practical.

Avoid duplicate APIs for nearly identical operations.

For large datasets:
- Use backend search/filter/sort/grouping where appropriate.
- Use pagination.
- Avoid loading entire datasets into the browser.
- Avoid N+1 queries.
- Use `select_related` / `prefetch_related` where appropriate.
- Avoid repeated queries inside loops and unbounded scans.

Do not optimize trivial code prematurely, but do not introduce obvious performance problems.

# 16. Global Table / Listing Standard

All existing and future listing pages must use the shared global table/listing system wherever possible.

Use consistent support, where relevant, for:
- Sorting by sortable column header
- Resizable columns
- Drag/reorder columns
- Column visibility
- Row hover/selection
- Bulk actions
- Search
- Page-specific filters
- Group By
- Pagination
- Loading, empty, and error states
- Responsive behavior
- Permission-aware actions
- Persistent user preferences where appropriate

Search, Filter, Group By, sorting, column sizing/reordering, and styling should be implemented through shared components/utilities, not rebuilt per page.

# 17. Responsive UI Standard

All existing and future frontend pages must be responsive and mobile-friendly.

Before considering UI work complete, verify desktop, tablet, and mobile.

Reuse shared responsive layouts/components. Avoid fixed widths/heights that cause overflow.

Forms, tables, drawers, modals, page headers, toolbars, cards, navigation, schedules, and settings must adapt to smaller screens.

Do not create desktop-only implementations or duplicate mobile versions unless there is a genuine reason.

Use the shared breakpoint scale documented in `frontend/src/styles/responsive.css`: 1280, 1024, 768, 640, 480. Do not introduce another width.

Do not put a fixed multi-column `gridTemplateColumns` in an inline style: an inline style cannot carry a media query, so it can never collapse. Use the `.form-grid` utilities.

Horizontal scrolling belongs inside a controlled container (a table wrapper, a calendar grid), never on the page itself.

`npm run test:responsive` runs the browser checks for these rules; `npm test` includes the static guards.

# 18. Global Theme Standard

All frontend pages must use the centralized Organization theme/design-token system where applicable.

Do not hard-code branding colors inside individual pages/components.

Reuse global theme variables/components so Organization branding changes apply consistently across the application.

Preserve accessibility, contrast, responsive behavior, RTL compatibility, and safe fallback defaults.

The token catalogue is defined once, in `backend/apps/settings_app/theme.py`. Adding a themeable colour means adding it there and mapping it in `frontend/src/theme/tokens.js`; nothing else needs to know a theme exists.

Components read CSS variables (`var(--color-primary-600)`). No component branches on the active theme.

A stored theme is validated server-side against the catalogue before it is saved, and resolved over the shipped defaults when read, so a partial or corrupt theme can never leave the interface unstyled.

# 19. Internationalization Standard

Use the project's centralized `react-i18next` architecture for user-facing static frontend text.

Do not hard-code reusable UI text when the localization system is available.

Use meaningful translation keys and reuse common keys where appropriate.

Do not translate internal IDs, status codes, API identifiers, user-entered data, or database values unless the feature explicitly supports multilingual content.

Support RTL/LTR through the global direction system, not page-specific hacks. Use logical CSS properties where practical.

Never store translated status text as business data. Store stable identifiers and translate display labels.

# 20. UI and UX Consistency

Before creating a UI component, inspect and reuse existing shared:
- Buttons
- Inputs
- Selects
- Tables
- Modals
- Drawers
- Date/time pickers
- Toasts
- Alerts
- Cards
- Layouts
- Loaders
- Empty states

Maintain consistent spacing, typography, icons, form behavior, validation, loading states, and interaction patterns.

Keep common workflows simple. Use progressive disclosure for advanced options.

# 21. Accessibility

Use proper labels, form associations, keyboard/focus behavior, button semantics, and error descriptions.

Do not use clickable `<div>` elements when a semantic button/link is appropriate.

# 22. Error Handling, Logging, and Auditing

Do not hide errors.

Backend errors must be safe and useful. Frontend errors must be understandable.

Never expose stack traces, SQL, secrets, internal paths, or sensitive internals to end users.

Log meaningful errors, security events, payment events, critical workflow failures, and third-party failures. Do not log passwords, tokens, secrets, full payment data, or unnecessary sensitive personal data.

Where auditing already exists, record meaningful business changes, not every UI interaction.

# 23. File Upload Safety

Validate file type, size, extension, MIME type where appropriate, permissions, and storage path.

Never trust user-provided filenames.

# 24. Third-Party and AI Safety

Reuse existing integrations. Keep secrets server-side. Handle timeouts, failures, retries, and rate limits. Avoid unnecessary expensive calls.

AI features must remain user-controlled.

AI may suggest, analyze, draft, highlight, or recommend, but must not silently save data, send communication, change pricing, cancel bookings, change permissions, or approve transactions.

For read-only AI reporting, expose only approved read-only reporting tools/services. Never give AI unrestricted SQL or write-capable business tools.

# 25. High-Impact Actions and Existing Bookings

Require confirmation for destructive/high-impact actions such as delete, cancel, refund, permission changes, bulk updates, facility closures, or destructive schedule changes.

If a configuration change conflicts with existing bookings:
- Detect affected bookings.
- Show them to the authorized user.
- Do not silently cancel, refund, move, or delete them.

# 26. Delete, Refactor, and Compatibility Safety

Before deleting code:
1. Search all references.
2. Check imports, APIs, frontend usage, tests, jobs, and docs.
3. Confirm it is truly unused.

Do not remove working features simply because the current task does not use them.

Keep refactors focused. Do not combine unrelated large refactors with a small feature unless necessary.

Before changing API payloads, field names, URLs, statuses, model behavior, or response structures, check all consumers and preserve compatibility where practical.

# 27. State, Status, Constants

Do not introduce a second state-management library if one already exists.

Avoid storing the same state in multiple places without reason.

Use centralized enums/constants for stable statuses, types, permission codes, booking states, payment states, and system constants where appropriate.

Do not scatter raw status strings throughout the codebase.

# 28. Async UI States

All asynchronous frontend features must handle:
- Loading
- Empty
- Success
- Error
- Retry where appropriate

Do not leave blank or ambiguous UI states.

# 29. Soft Delete and Historical Integrity

Where the project already uses soft delete/archive patterns, continue using them consistently for business records that require history.

Do not introduce hard delete where it would damage historical/audit integrity.

# 30. Parallel Development Safety

Parallel work is allowed only for genuinely independent tasks.

When another IDE/session is working in parallel:
- Keep this task inside its assigned files/modules.
- Do not modify unrelated shared files.
- Before changing a shared/core file, stop and report why it is required.
- Avoid simultaneous migrations or overlapping changes to global settings, routes, theme providers, shared components, global CSS, or project rules.
- Keep changes isolated and easy to review/merge.

Read-only analysis may happen in parallel, but conflicting implementation should not.

# 31. No Em Dash

Never use the em dash character in UI text, labels, buttons, messages, comments, documentation, translation resources, or generated project content.

Use a hyphen, colon, comma, or parentheses instead.

# 32. Implementation Workflow

For every substantial task:

## Step 1 - Inspect
Understand the existing implementation and dependencies.

## Step 2 - Plan
Determine what to reuse, what must change, risks, security impact, database impact, and affected consumers.

## Step 3 - Implement
Make focused, minimal, architecture-consistent changes.

## Step 4 - Validate
Run relevant checks/tests/builds.

## Step 5 - Review
Check duplication, security, permissions, data isolation, responsiveness, RTL/i18n, naming, performance, edge cases, and dead code.

## Step 6 - Report
Summarize files changed, main implementation, model/API changes, security considerations, tests actually performed, pre-existing issues, and known limitations.

# 33. Testing Rules

Test what you change and relevant edge cases.

Run applicable:
- Django checks
- Unit/API tests
- Frontend build
- Type checks
- Lint
- Existing automated tests

Consider invalid input, unauthorized users, wrong Organization/Club/Facility scope, duplicate submissions, concurrency, empty/large datasets, timezone differences, overnight schedules, API/network failure, and responsive layouts.

Clearly distinguish:
- Pre-existing issues
- Issues introduced by the current task
- Issues fixed during the current task

Never claim something was tested, verified, working, or passed unless the relevant check was actually performed.

# 34. Ambiguous Requirements

Do not invent major business rules.

Use existing project behavior as the first reference.

If ambiguity could materially affect data, security, booking logic, pricing, payments, permissions, or destructive behavior, stop and ask before implementing that part.

For minor implementation details, use sound engineering judgment.

# 35. Documentation

Document meaningful architectural additions such as new models, services, APIs, permissions, environment variables, background jobs, or major shared components.

Do not create unnecessary documentation for trivial changes.

# 36. Listing Page Layout Standard

A listing is a full-page workspace, not a card floating on a padded page.

Build every listing page with `ListPage` from `components/listview`:

```jsx
<ListPage title={...} subtitle={...} actions={...} tabs={...}>
  <ListView ... />
</ListPage>
```

`ListPage` supplies the workspace; `ListView` supplies the behaviour. Do not
reintroduce `PageHeader` beside a `ListView`, and do not wrap a listing in
`.card`.

Rules:

- The heading, toolbar, table and pagination share one gutter (`--lv-gutter`),
  so a column heading lines up with the page title above it and the row count
  below it.
- The workspace cancels the shell's page padding through `--app-gutter`, which
  `.app-content` publishes. Never hard-code that number in a second place.
- The table takes the height that is left and scrolls inside itself, so the
  toolbar and the paging controls stay reachable in a long list. Below the 768
  breakpoint the workspace releases the viewport height and the page scrolls
  normally: a nested scroller under a mobile browser's collapsing chrome is
  worse than no scroller at all.
- A body the page renders itself (a card grid, a calendar, a kanban) goes in
  `.lv-altbody` so it occupies the same region the table would have.
- A page with tabs passes them as `tabs` and uses the shared `PageTabs`
  component. Do not write another inline tab style.
- `wide` opts a page out of the fixed-height workspace when its body is not a
  single table.

All existing table behaviour is unchanged: sorting, resizing, reordering,
column visibility, grouping, selection, bulk actions, filters, search,
pagination, saved preferences, permission-aware actions, and the loading, empty
and error states.

`npm test` enforces this standard in `components/listview/layout.test.js`.

# 37. Website Campaign Standard

Website campaigns and popups are presentation and marketing features only.

They may promote holidays, offers, promo codes, memberships, facilities or
events, but they must reuse existing business logic for availability, pricing,
discounts, booking and payments. A campaign references those systems; it never
reimplements them. A campaign record must never carry a discount, a price, an
entitlement or a slot.

Campaign visibility is resolved on the backend: publication, enablement, the
configured start/end in the organization's timezone, placement, scope, audience
and priority. The browser is told only which campaigns it may show, and decides
how often from the campaign's frequency, because that depends on what this
visitor has already dismissed.

Only the highest-priority eligible campaign opens. Others queue; popups never
stack.

The public payload lists what may go out rather than stripping what may not.
Internal notes, draft rows, engagement figures and scope never reach a visitor.

Cached eligibility is invalidated on every campaign write, so a campaign that is
switched off stops appearing at once.

Do not create duplicate promotion, CMS, popup, preview or analytics systems when
existing infrastructure can be reused.

# 38. Final Quality Check

Before considering a task complete, confirm:
- Existing code was inspected first.
- Existing functionality was reused where possible.
- No duplicate source of truth was introduced.
- Security and permissions were preserved.
- Organization/Club/Facility isolation is correct.
- Backend remains authoritative for business logic.
- Responsive behavior was considered.
- Theme and localization standards were followed where applicable.
- Edge cases and performance were considered.
- Relevant checks/tests were actually run.
- No prohibited Git/server/database action was performed.
- No secret/generated file was introduced into Git.
- No em dash was added.

If any item is not satisfied, fix or clearly report it before completing the task.
