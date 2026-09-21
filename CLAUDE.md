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

## Availability-Aware Calendar

Customer booking calendars must not present a date as selectable unless the
authoritative backend availability engine confirms that at least one valid
booking option exists for that date under the current booking rules.

Do not require customers to click dates just to discover there are no slots.

Use efficient date-range availability summaries, preserve final backend
revalidation, and avoid duplicate availability logic.

## Calendar Offer and Time Classification Standard

Customer booking calendars may display compact offer indicators only when the
backend confirms a customer-visible promotion is applicable to that booking
context.

Offer indicators are informational. They must never create availability and
must never perform a pricing calculation in the frontend: availability is
resolved first, the offer second, and both the label and the price come from
the backend.

Business-hour periods may be classified as Normal, Hot or Cold using the
existing schedule architecture, stored on the shift so the classification
inherits and is replaced exactly as the hours are. The classification may be
used by pricing, reporting and customer UI, but must not change pricing unless
an explicit pricing rule names the period it applies to.

Reuse the existing schedule, pricing, promotion and availability engines. Do
not create duplicate logic.

# 13. Concurrency and Transaction Safety

Use transactions for operations that must succeed or fail together, especially:
- Booking creation
- Payment + booking update
- Slot reservation
- Multi-record status changes
- Resource allocation

Prevent double booking and race conditions. Revalidate availability before final creation and use locking/constraints where appropriate.

## Booking Workflow Integrity

All booking entry points, including the customer website, admin, manual
booking, reschedule, multi-slot and API flows, must use the same authoritative
backend availability, pricing, entitlement and payment rules.

A confirmed or otherwise slot-blocking booking must make that exclusive slot
unavailable to all other bookings until it is validly cancelled, expired or
released.

Never rely on frontend availability. Revalidate and protect slots atomically
before booking confirmation.

Allocation reads which facilities are free and then writes a booking. Those
two steps must be one step as far as any other booking is concerned. Row locks
do not achieve that, because the thing being protected is the ABSENCE of a
conflicting row: the club/day advisory lock in `allocate_facility` is what
serialises it, and the partial unique index on (facility, date, start) is the
backstop, not the protection.

Prevent double booking, duplicate payment, duplicate entitlement consumption,
duplicate loyalty posting and duplicate notifications through transactions,
concurrency protection and idempotency.

Pricing, promo, offers, holidays, subscriptions, packages, loyalty, add-ons,
tax and finance must be integrated into the same booking lifecycle and must
not operate as isolated parallel logic.
### Slot occupancy, payment window and discount order

Three rules that were previously implicit and are now fixed.

**What occupies a slot** is `SLOT_BLOCKING_STATUSES` in `apps.bookings.models`,
and nothing else. It is wider than `ACTIVE_STATUSES`: a completed or closed
booking still held that court for its period, so marking a booking complete
early must not hand the court to somebody else while it is in use. Cancelled
and no-show release the slot. Availability, allocation and the database
constraint all read that one set.

**An unpaid booking is released only when it is certainly abandoned.** A
website checkout that chose to pay online, took no money, has no live split
arrangement, is still in the opening status and is past
`BOOKING_PAYMENT_WINDOW_MINUTES` is cancelled by
`expire_unpaid_bookings`. A pay-at-venue booking, a part-paid booking, an
admin or walk-in booking, and a booking whose payment method was never
recorded are never released by the clock. Not knowing is a reason to leave a
booking alone, not a reason to cancel somebody's court.

**Discounts compose in one order**: catalogue price, then automatic pricing
rules (offers), then the promo code on the already-discounted subtotal, then
loyalty, then VAT. Offers and promo codes stack; neither replaces the other,
and the total can never go below zero.

# 14. Date, Time, and Money

Use timezone-aware datetimes. Do not treat browser time as authoritative.

Use configured Organization/Club timezone where applicable. Handle overnight schedules, date boundaries, UTC conversion, and DST where relevant.

Never use floating-point arithmetic for money. Use Decimal/proper monetary fields and consistent rounding, tax, discount, refund, and currency handling.

## Payment Integrity

Booking totals, paid amounts and outstanding balances are backend-authoritative.

Split payments may divide a valid final payable amount between multiple payment transactions but must never create a second booking total, bypass availability, bypass pricing, or allow overpayment.

All payment actions must be idempotent, concurrency-safe, permission/scope validated and integrated with the existing payment/refund architecture.

Never store or log CVV or raw sensitive card details.

Demo payment behavior must never operate in production.

### Split payment: confirmed financial policy

These two rules were undefined until they were decided explicitly. Do not change
them, and do not add automated financial behavior around them, without asking.

**Expiry is inert.** When a split payment deadline passes with only part of the
balance collected, the payment links stop working and nothing else happens. No
refund is issued, no booking is cancelled, no slot is released, no status
changes. A human resolves a part-paid booking using the existing cancellation
and credit note tools.

**Refunds follow the payer.** A booking settled by several people is refunded
per participant, each against their own payment, through the normal credit note
flow and honouring `Organization.require_refund_approval`. Cancelling such a
booking does not refund anybody automatically, and the full amount is never
returned to the organizer alone. Every share therefore has to keep its payer,
its amount and its payment reference, and each share's payment must raise its
own invoice.

## Multi-Slot Booking Integrity

A multi-slot checkout is ONE `BookingOrder` and one ordinary `Booking` per
slot. It is not a new booking type and not a second booking engine.

Every slot goes through the existing availability engine, the existing
`BookingCreateSerializer`, the existing pricing and the existing
`(facility, date, time)` uniqueness guarantee. Creation is atomic: if any slot
fails, the whole order unwinds.

The order holds no money. Each booking keeps its own authoritative price
snapshot, because slots can be priced differently and refunding one slot must
return what that slot actually cost. Order totals are summed from the bookings,
never stored.

How many slots may be booked, whether they may span dates and whether they must
run back to back are resolved by the backend from the Organization, Club and
Facility chain, one setting at a time. The browser never works this out.

The website books an ACTIVITY at a club, not a named facility, so the offer is
the most permissive of what the eligible facilities allow. The allocation is
then re-checked against each facility's own rules after the allocator has run,
inside the same transaction, so a permissive court can never be used to
overfill one that caps itself.

A promo is validated, redeemed and capped ONCE per order, then allocated across
the slots in proportion to price.

### Multi-slot payment and refunds: confirmed policy

These were decided explicitly. Do not change them without asking.

**A split share is an amount of the order, not a set of slots.** Paying a share
spreads that amount across the slots in proportion to what each still owes, so
one share may raise several invoices. Every payment records its payer, so
refunds still follow the payer.

**Cancelling one slot of a paid order refunds nothing automatically.** The slot
is cancelled and the money stays where it is. A human issues a credit note
through the existing flow, honouring `Organization.require_refund_approval`.
This matches the precedent set for split expiry being inert: money never moves
without a person deciding.

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

# 38. Reservation Holds and Payment Methods

A court is claimed by a `BookingHold` while the customer pays, not by an unpaid
booking row. The hold owns the deadline; the booking owns the commerce. When
payment lands the hold CONVERTS and the confirmed booking takes over blocking
the slot; when the clock runs out the hold EXPIRES and the court is free again.

A hold is all or nothing. Reserving two of three chosen slots and reporting
failure would lock a court for a booking that is not going to happen.

Acquisition and allocation take the SAME club/day advisory lock, so a hold and
a booking can never be handed the same court. Availability, allocation and the
range summary all subtract live holds.

Expiry is read, never assumed. The sweep runs every few minutes, so rows sit
ACTIVE past their deadline in between. Every read asks the clock as well as the
status.

## Confirmation requires the money, for one case only

A website checkout that chose to pay online and has collected nothing may not
become Confirmed. That is the same condition `expire_unpaid_bookings` uses to
release a slot, read from one predicate, `services.awaiting_online_payment`, so
the two can never disagree about a booking.

Nothing else is gated. Pay-at-venue, admin and walk-in bookings, part-paid,
covered and zero-value bookings, and anything whose payment method was never
recorded all confirm as before. Staff committing a court in person is a
decision, not an oversight. A gate that refuses too much is not the safer gate.

Assigning a worker walks a booking through Confirmed, so it asks the same gate,
BEFORE it writes anything.

## Draft is an unfinished form, not a reservation

A draft exists because an admin gets interrupted halfway through taking a
booking and would rather keep what they typed. Only an admin creates one, and
only through `save_as_draft` on creation: `status` is not client-writable, and
the flag is ignored on an edit, because demoting a real booking back to a
draft would take its court away without cancelling anything.

**A draft holds NO court.** There is no clock on a draft, so one that is
forgotten would take a court off sale for ever. The slot stays on sale and
availability is checked in `services.finish_draft`, which is the moment the
draft stops being a form and starts occupying something. That check can fail,
and failing there is the point: the alternative is a court promised twice.

`DRAFT` is outside `ACTIVE_STATUSES` and `SLOT_BLOCKING_STATUSES`, so it also
counts against no per-customer cap. It moves only to BOOKED or CANCELLED, and
nothing moves into it.

A draft is excused the COMPLETENESS rules in `Booking.clean` and the
serializer (no customer, no activity) and nothing else. Consistency rules
still apply, because naming a court at the wrong club is a mistake rather
than an omission, and date and time stay required: the slot index, the
filters and every listing assume a booking has a when. `finish_draft` runs
every excused rule again before the booking becomes real.

## Staff see a hold; customers do not

The same fact, two audiences, two right answers. A customer only needs to
pick something else, so the website withdraws a held slot. A receptionist
with somebody at the desk needs to know whether it is worth waiting, so the
admin slot picker labels it "being booked" rather than "full".

A refusal from `allocate_facility` says how long the reservation has left
when a reservation is the reason. Staff refused on a calendar with nothing on
it conclude the software is broken: a reservation leaves no booking row, so
there is nothing on the day view to explain it. `services.minutes_held` is
for that message only, never for deciding availability, and it reports
relative minutes so it needs no timezone conversion and cannot be an hour
wrong.

`expire-holds` runs on the beat every five minutes. It is housekeeping, not
protection: every read already enforces a deadline from the clock, so a court
is never blocked by a row the sweep has not reached. Without it the table
fills with rows still claiming to be active, and every "what is held right
now?" question gets the wrong answer.

## A held slot is not a booked slot

Availability merges holds and bookings, because both make a court
unavailable. The slot payload keeps them apart: `held` is how many courts a
live reservation is holding, and a court that is both booked and held counts
as booked, since that is the state a clock running out will not change.

The website WITHDRAWS a slot that is only held rather than labelling it.
"Fully booked" is untrue when nobody has booked it, and the slot may be free
again within minutes: a customer who reads "booked" writes that time off, one
who sees nothing picks another. A genuinely booked slot keeps its place and
its label, because that one is not coming back today.

An expired reservation is sticky per selection. A refresh must not silently
start a new window, or the deadline means nothing to anybody willing to press
F5. The mark clears when the customer leaves the checkout, which is the
explicit act the "Pick times again" message asks for.

## The countdown is presentation, the hold is not

`show_hold_countdown` (Organization, overridable per club) decides whether the
customer sees the clock. It changes NOTHING else: the court is held for the
same length of time either way. A setting that quietly stopped holding courts
would reintroduce the double booking this whole feature exists to prevent.

Hiding it still shows the expiry and refusal messages. A customer whose
reservation ran out has to be told something, or they meet an unexplained
refusal at the Pay button.

Reservations have their OWN throttle scope, `public_reservation`. They are
claimed far more often than bookings are made, so sharing `public_booking`
meant ordinary browsing exhausted the allowance and the booking itself was
then refused. Reading and releasing a reservation are not throttled at all:
rate limiting the operation that FREES a court leaves it locked until its
deadline, which costs the club a slot it could have sold.

Only a 409 from the reservation endpoint is shown to the customer. A throttle,
a server error or a dropped connection is our problem, not theirs, and
checkout still works because the backend revalidates before it writes.

Leaving the checkout releases the courts, but "leaving" is a TRANSITION. Every
page load renders the wizard at its first step while it reads the URL, so an
unguarded check releases the reservation on mount, before the restore reaches
the payment step. That is what made a language switch restart the countdown at
ten minutes and put the court back on sale in between.

## Spending a reservation

The checkout sends its reservation token with the booking. Two things follow
from that and neither is optional.

The customer's OWN hold must not block their own booking, so `exclude_hold_id`
is threaded explicitly from `create_public_booking` and `create_public_order`
down through `validate_selection`, `slot_is_available`, the
`BookingCreateSerializer` context and `allocate_facility`. It travels in the
serializer CONTEXT, never the payload, so a caller cannot ask to ignore
somebody else's hold.

A token may only be spent on slots it actually holds (`reservations.covers`).
Otherwise a token for 7pm could be used to book 8pm, and converting it would
quietly give away the 7pm court.

Conversion happens inside the booking transaction, after the booking exists
and is already blocking the slot, so there is no instant at which the court
looks free and a rollback takes the conversion with it.

A booking with no token still works exactly as before. Rubbish in the field
does not: silently ignoring an unreadable token would book a court that was
never held.

## The countdown

`expires_at` is issued by the server and always sent with `server_time`. The
browser anchors its countdown on the difference between the two, because a
device whose clock is twenty minutes fast would otherwise declare a live
reservation dead.

The token is kept in `sessionStorage` under a signature of what was reserved,
and the signature ignores the order slots were clicked in. A reload on the
payment step re-reads the existing reservation rather than claiming a second
one, which would be refused by the customer's own hold and would look exactly
like somebody else taking the slot.

Leaving the checkout releases the courts at once instead of making the next
customer wait out a timer nobody is watching.

## Timeouts and payment methods are settings, not constants

`hold_unpaid_minutes`, `hold_partly_paid_minutes`, `hold_max_minutes`,
`split_enabled`, `split_hold_minutes`, `split_max_shares` and `cash_enabled`
live on the Organization, and a Club may override any of them one at a time. A
null club value inherits. `settings_app.schedule.resolve_booking_policy` is the
only place that chain is resolved; nothing reads the fields directly.

`split_hold_minutes` is clamped to `hold_max_minutes`, because payment links
that outlive the reservation would keep collecting for a court already resold.

Pay at venue is offered only where `cash_enabled`. The website hides the tile
and the server refuses the method, from the same
`gateway.checkout_payment_options` payload, so a customer is never refused for
something the page said was fine. A checkout that names no method gets the
club's default rather than cash: a cash booking is deliberately exempt from the
expiry sweep, so recording one where cash is not accepted would hold a court
that nobody could ever pay for.

# 39. Final Quality Check

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
