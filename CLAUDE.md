# CLAUDE.md

This file defines mandatory rules for Claude when working in this repository.

These rules apply to every task unless I explicitly override a specific rule for that task.

# MOST IMPORTANT RULE

Do not treat my instruction as permission to immediately write code.

First inspect the existing implementation, understand how the feature currently works, identify reusable code, dependencies, security implications, and potential side effects. Then make the smallest clean change that satisfies the requirement.

Never add secrets, credentials, API keys, database dumps, generated reports, local uploads, virtual environments, node_modules, build outputs, cache files, or IDE-specific files to Git. Before any Git commit, review staged files and verify that no sensitive or generated files are included.

# PROJECT WORKING PRINCIPLES

## 1. Understand Before Implementing

Before writing, modifying, deleting, or refactoring code:

- Inspect the existing codebase first.
- Understand the current architecture.
- Search for existing implementations.
- Check whether a similar feature already exists.
- Identify dependencies and side effects.
- Understand related models, APIs, services, frontend components, permissions, and workflows.
- Reuse existing patterns where appropriate.

Never start implementation based only on assumptions.

Do not create a new implementation until you have confirmed that the required functionality does not already exist.

---

# 2. NEVER CREATE DUPLICATE SOURCES OF TRUTH

This is a critical rule.

Never create duplicate:

- Models
- Tables
- Services
- Business logic
- API endpoints
- Utilities
- Constants
- Settings
- Permissions
- Validation logic
- Components
- Hooks
- State stores
- Configuration
- Schedule engines
- Pricing engines
- Booking logic

If functionality already exists, extend or refactor the existing source instead of creating another parallel implementation.

There must be one authoritative source for each business rule.

For example:

Do not calculate booking availability separately in:

- Backend
- Frontend
- Different APIs
- Different facility modules

The backend should remain the authoritative source for business-critical logic.

---

# 3. DRY PRINCIPLE

Follow DRY: Don't Repeat Yourself.

Before creating a new:

- Function
- Class
- Component
- Utility
- Hook
- Serializer
- Service
- API
- Validation
- Query

search for an existing reusable implementation.

If two modules perform almost the same task, consider extracting shared logic instead of duplicating code.

Do not over-abstract simple logic, but avoid obvious duplication.

---

# 4. ENTERPRISE-QUALITY CODE STRUCTURE

Write code as if multiple developers will maintain this project for years.

Code must be:

- Clear
- Predictable
- Modular
- Maintainable
- Readable
- Testable
- Secure
- Extensible
- Consistent with the existing architecture

Prefer simple, explicit architecture over clever or overly complex solutions.

Avoid unnecessary abstraction.

Avoid tightly coupled code.

Keep responsibilities clearly separated.

---

# 5. FOLLOW EXISTING PROJECT ARCHITECTURE

Do not introduce a completely different coding style or architecture without a strong reason.

Before implementing a feature:

- Identify existing app/module structure.
- Follow existing service patterns.
- Follow existing API conventions.
- Follow existing serializer patterns.
- Follow existing frontend component conventions.
- Follow existing state management.
- Follow existing permission architecture.
- Follow existing error response formats.

Consistency is more important than introducing a new pattern unnecessarily.

If the existing architecture has a serious design problem, explain it before making a major structural change.

---

# 6. SECURITY MUST NEVER BE BYPASSED

Never bypass or weaken security to make a feature work.

Never disable or circumvent:

- Authentication
- Authorization
- Role validation
- Permission checks
- Object-level permissions
- Organization boundaries
- Club boundaries
- Facility boundaries
- CSRF protection
- CORS rules
- API validation
- Input validation
- Rate limiting
- Audit logging
- Ownership checks
- Tenant isolation
- File validation

Never implement frontend-only security for protected actions.

All important authorization must be enforced by the backend.

Frontend permission checks are for UX only, not security.

---

# 7. STRICT DATA ISOLATION

Always respect data ownership and scope.

For this project, carefully maintain boundaries between:

- Organization
- Club
- Facility
- User
- Customer
- Booking

Never allow records from one scope to leak into another.

Every query must be reviewed for correct filtering.

Never trust IDs coming from the frontend without validating that the current user has permission to access the related object.

---

# 8. DO NOT TRUST CLIENT INPUT

Treat all frontend and API input as untrusted.

Validate:

- IDs
- Dates
- Times
- Amounts
- Status values
- File uploads
- Foreign keys
- Permissions
- User-supplied text
- Query parameters

Do not rely only on frontend validation.

Backend validation is mandatory.

---

# 9. NO HARDCODED SECRETS

Never hard-code:

- API keys
- Database passwords
- Tokens
- Secret keys
- SMTP credentials
- Third-party credentials
- Cloud credentials

Use environment variables.

Never expose sensitive `.env` values in logs, responses, screenshots, documentation, or code.

---

# 10. .ENV SAFETY

Do not modify production or server `.env` files without my explicit confirmation.

For local development:

- Reuse existing environment variable conventions.
- Do not rename environment variables unnecessarily.
- Do not create duplicate variables for the same purpose.

If a new variable is required, document:

- Name
- Purpose
- Example value format

Never reveal its real secret value.

---

# 11. DATABASE SAFETY

Never perform destructive database actions without explicit confirmation.

Do not:

- Drop databases
- Drop tables
- Truncate tables
- Delete production data
- Reset production databases
- Modify production records manually
- Run destructive SQL

Before changing models:

- Inspect existing models.
- Inspect relationships.
- Inspect migration history.
- Check existing data assumptions.
- Check APIs and frontend dependencies.

Do not create duplicate tables for functionality already represented by an existing model.

---

# 12. MIGRATION SAFETY

Never run migrations on a production/live server without my explicit confirmation.

Before generating a migration:

- Review whether the schema change is actually required.
- Check whether an existing field/model can be reused.
- Avoid unnecessary schema changes.
- Consider backward compatibility.
- Consider existing records.

Never edit old applied migrations casually.

Never rewrite migration history without a clear reason and explicit approval where destructive.

---

# 13. GIT SAFETY

Never perform any Git write operation without my explicit confirmation for that specific action.

This includes:

- git commit
- git push
- git merge
- git rebase
- git reset
- git reset --hard
- git cherry-pick
- git revert
- branch deletion
- force push
- tag creation
- history rewriting

You may use read-only Git commands such as:

- git status
- git diff
- git log
- git branch
- git show

when needed to understand the project.

Do not assume approval from a previous Git operation.

Each commit or push requires fresh confirmation.

---

# 14. SERVER PROTECTION

Never modify or deploy to a live server without explicit confirmation.

Do not:

- Deploy
- Restart services
- Restart containers
- Modify Nginx
- Modify Apache
- Modify systemd
- Modify firewall rules
- Modify DNS
- Modify production environment variables
- Run production database migrations
- Update production dependencies

without manual approval.

---

# 15. STRICT PROJECT BOUNDARY

Work only inside this repository/project.

Never:

- Access another project
- Modify another project
- Read another project's source code
- Change another project's database
- Copy code from unrelated projects
- Modify global system configuration unless explicitly required

If something appears to require access outside the current project, stop and report it.

---

# 16. NEVER USE EM DASH

Never use the em dash character in:

- UI text
- Labels
- Buttons
- Messages
- Documentation
- Comments
- Generated content

Use:

- Hyphen
- Colon
- Parentheses
- Comma

instead.

This is a permanent project rule.

---

# 17. RESPONSIVE DESIGN IS MANDATORY

Every frontend feature must be designed for:

- Desktop
- Laptop
- Tablet
- Mobile

Do not build desktop-only pages.

Check:

- Table overflow
- Form layout
- Modal size
- Drawer behavior
- Navigation
- Button wrapping
- Touch targets
- Long text
- Empty states

Responsive behavior is part of feature completion.

---

# 18. REUSE EXISTING UI COMPONENTS

Before creating a new UI component, inspect existing shared components.

Reuse existing:

- Buttons
- Inputs
- Selects
- Modals
- Drawers
- Tables
- Date pickers
- Time pickers
- Alerts
- Toasts
- Cards
- Layouts
- Loaders
- Empty states

Do not create visually inconsistent duplicate components.

---

# 19. UI CONSISTENCY

Maintain consistent:

- Spacing
- Typography
- Button styles
- Form controls
- Table design
- Colors
- Modal behavior
- Drawers
- Icons
- Validation messages
- Loading states
- Empty states

Do not introduce isolated styling patterns unless necessary.

---

# 20. UX SHOULD BE SIMPLE

Do not expose all advanced controls at once.

Prefer:

- Progressive disclosure
- Expandable sections
- Drawers
- Context menus
- Tabs
- Clear defaults

Make common tasks fast.

Advanced options should not make normal workflows complicated.

---

# 21. NO SILENT BUSINESS LOGIC CHANGES

Never change important business behavior silently.

Examples:

- Booking rules
- Cancellation rules
- Pricing
- Availability
- Payment behavior
- Permissions
- Status transitions

If a requested UI change requires business logic changes, identify them explicitly.

Do not assume the user wants behavior changed just because the UI is changing.

---

# 22. BACKEND IS AUTHORITATIVE

Business-critical logic must live in the backend.

Examples:

- Availability
- Pricing
- Permission checks
- Booking validation
- Conflict detection
- Status transitions
- Payment validation
- Facility access
- Schedule resolution

Frontend may display or assist with these rules but should not be the only place enforcing them.

---

# 23. API DESIGN

APIs must be:

- Predictable
- Consistent
- Properly validated
- Permission protected
- Backward compatible where practical
- Clear in error responses

Do not create multiple APIs that perform nearly identical operations without a valid reason.

Prefer extending an existing API when appropriate.

---

# 24. QUERY PERFORMANCE

Avoid unnecessary database queries.

Watch for:

- N+1 queries
- Repeated queries inside loops
- Unbounded queries
- Large table scans
- Missing select_related
- Missing prefetch_related
- Repeated aggregate queries

Optimize where justified.

Do not prematurely optimize trivial code, but do not introduce obvious performance problems.

---

# 25. PAGINATION

Large datasets must not be loaded completely into the UI or API unnecessarily.

Use pagination for:

- Customers
- Bookings
- Clubs
- Facilities
- Transactions
- Logs
- Reports

Reuse existing pagination conventions.

---

# 26. FILTERING AND SEARCH

Filtering should primarily happen through backend APIs for large datasets.

Avoid downloading all data to the browser just to filter locally.

Respect permission and organization scopes in all filters.

---

# 27. TRANSACTION SAFETY

Use database transactions for operations that must succeed or fail together.

Examples:

- Booking creation
- Payment + booking update
- Slot reservation
- Multi-record status changes
- Inventory/resource allocation

Avoid partial state.

---

# 28. CONCURRENCY SAFETY

Booking systems are sensitive to race conditions.

For availability and booking flows:

- Do not trust a slot simply because it looked available earlier.
- Revalidate before final booking creation.
- Prevent double booking.
- Use appropriate transactions or locking where required.
- Consider concurrent requests.

Never rely only on frontend availability checks.

---

# 29. DATE AND TIME SAFETY

Use timezone-aware date/time handling.

Do not assume browser timezone is authoritative.

Use configured organization/club timezone where applicable.

Handle:

- Overnight schedules
- DST where applicable
- Date boundaries
- UTC conversion
- Local display time

Avoid naive datetime usage.

---

# 30. MONEY HANDLING

Never use floating-point arithmetic for monetary calculations.

Use:

- Decimal
- Proper currency fields

Handle:

- Rounding
- Taxes
- Discounts
- Currency
- Refunds

consistently.

---

# 31. STATUS MANAGEMENT

Do not scatter raw string statuses throughout the code.

Use centralized enums/constants where the project supports them.

Example:

Avoid:

`status == "confirmed"`

in many unrelated locations if a central enum already exists.

Use one authoritative definition.

---

# 32. CONSTANTS AND ENUMS

Do not duplicate literal values.

Centralize:

- Statuses
- Types
- Permission codes
- System constants
- Booking states
- Payment states

where appropriate.

Do not over-centralize UI-only text unnecessarily.

---

# 33. ERROR HANDLING

Do not hide errors.

Handle errors intentionally.

Backend should return useful, safe responses.

Frontend should show understandable messages.

Do not expose:

- Stack traces
- Secrets
- SQL
- Internal server paths
- Sensitive internal details

to end users.

---

# 34. LOGGING

Use meaningful logging.

Log important:

- Errors
- Payment events
- Security events
- Critical workflow failures
- External API failures

Do not log:

- Passwords
- Tokens
- Secret keys
- Full payment details
- Sensitive personal information unnecessarily

Avoid excessive debug logging in production paths.

---

# 35. AUDIT LOGS

Where the project already supports auditing, capture meaningful business changes.

Examples:

- Booking status changed
- Facility schedule changed
- Pricing changed
- Permission changed
- Refund processed
- Facility disabled

Do not audit every mouse click or UI interaction.

---

# 36. DELETE SAFELY

Before deleting code:

1. Search all references.
2. Check imports.
3. Check APIs.
4. Check frontend usage.
5. Check tests.
6. Check background jobs.
7. Check documentation.
8. Confirm it is truly unused.

Never delete based only on file name.

---

# 37. REFACTOR SAFELY

Do not combine large unrelated refactors with a small feature unless necessary.

Prefer focused changes.

If a large refactor is required:

- Explain why.
- Identify affected areas.
- Preserve behavior.
- Validate after changes.

---

# 38. BACKWARD COMPATIBILITY

Before changing:

- API payloads
- Field names
- URLs
- Model behavior
- Status values
- Response structures

check existing consumers.

Do not break existing functionality unnecessarily.

---

# 39. DO NOT REMOVE WORKING FEATURES WITHOUT CONFIRMATION

If an existing feature appears unnecessary, do not remove it merely because the current task does not use it.

Confirm whether it is:

- Obsolete
- Still used
- Planned
- Shared

before deleting it.

---

# 40. TEST WHAT YOU CHANGE

Every meaningful change should be validated.

Run applicable:

- Django checks
- Unit tests
- API tests
- Frontend build
- Type checks
- Lint
- Existing automated tests

Do not claim something works unless it has actually been checked where practical.

---

# 41. TEST EDGE CASES

Do not test only the happy path.

Consider:

- Missing values
- Invalid input
- Unauthorized user
- Wrong organization
- Wrong club
- Wrong facility
- Duplicate submissions
- Concurrent requests
- Empty datasets
- Large datasets
- Timezone differences
- Overnight schedules
- API failures
- Network failure

---

# 42. DO NOT HIDE PRE-EXISTING ERRORS

If checks fail because of existing project issues, report them separately.

Clearly distinguish:

- Pre-existing issue
- Issue introduced by current change
- Issue fixed during current task

Do not silently modify unrelated code just to make all tests green.

---

# 43. COMMENTS

Write comments only where they provide useful context.

Do not add obvious comments such as:

`# Increment counter`

Prefer explaining:

- Why something unusual exists
- Business rule reasoning
- Compatibility constraints
- Security concerns

---

# 44. NAMING

Use clear names.

Avoid vague names such as:

- data
- temp
- item
- obj
- result2
- test123

when a meaningful name can be used.

Names should make the code understandable without excessive comments.

---

# 45. SMALL FUNCTIONS AND CLEAR RESPONSIBILITIES

Avoid giant methods or components.

Functions should ideally have one clear responsibility.

If a function:

- Validates
- Queries
- Transforms
- Saves
- Sends notifications
- Logs

all at once, consider separating concerns.

Do not split code into tiny meaningless functions either.

Use judgment.

---

# 46. SERVICE LAYER

For meaningful business logic, prefer the project's existing service layer rather than placing complex logic inside:

- Views
- Serializers
- React components

Keep controllers/views thin where practical.

Do not create a service layer if the project intentionally follows another established pattern.

Follow the existing architecture first.

---

# 47. SERIALIZER / SCHEMA RESPONSIBILITY

Serializers and request schemas should handle:

- Data shape
- Basic validation
- Input/output conversion

Complex business logic should not be duplicated across serializers.

Use existing project conventions.

---

# 48. FRONTEND COMPONENT RESPONSIBILITY

Do not put:

- API logic
- Large business rules
- Complex transformations
- Permission algorithms

directly inside presentation components if the project has services/hooks for those concerns.

Keep components understandable.

---

# 49. STATE MANAGEMENT

Do not introduce another state management library if the project already has one.

Reuse the current approach.

Avoid storing the same state in multiple places.

Do not duplicate:

- API data
- Form state
- Global state

without reason.

---

# 50. LOADING AND ERROR STATES

Any asynchronous frontend feature must consider:

- Loading
- Empty
- Success
- Error
- Retry where appropriate

Do not leave users with blank pages during failures.

---

# 51. ACCESSIBILITY

Use proper:

- Labels
- Form associations
- Keyboard support
- Focus behavior
- Button semantics
- Error descriptions

Avoid clickable `<div>` elements where actual buttons should be used.

---

# 52. FILE UPLOAD SECURITY

For file uploads validate:

- File type
- File size
- Allowed extensions
- MIME type where appropriate
- Storage path
- Permissions

Never trust filenames supplied by users.

---

# 53. THIRD-PARTY API SAFETY

When using external APIs:

- Reuse existing integrations where possible.
- Never expose secret keys.
- Handle timeouts.
- Handle failures.
- Avoid infinite retries.
- Log failures safely.
- Respect rate limits.

Do not call expensive APIs unnecessarily.

---

# 54. AI FEATURE SAFETY

Any AI feature must remain user-controlled.

AI may:

- Suggest
- Analyze
- Draft
- Highlight
- Recommend

AI must not silently:

- Save business data
- Send communication
- Change pricing
- Cancel bookings
- Modify permissions
- Approve transactions

without an explicit user action.

---

# 55. USER CONFIRMATION FOR HIGH-IMPACT ACTIONS

Use confirmation for actions such as:

- Delete
- Cancel booking
- Refund
- Close facility
- Bulk update
- Permission change
- Destructive schedule changes

Where existing bookings may be affected, warn the user before applying the change.

---

# 56. DO NOT AUTO-CANCEL EXISTING BOOKINGS

Configuration changes must not silently cancel existing reservations.

If a schedule, facility, or availability change conflicts with existing bookings:

- Detect conflicts.
- Show affected bookings.
- Require explicit user decision.

---

# 57. SOFT DELETE

Where the existing project uses soft delete, continue using it consistently.

Do not introduce hard delete for entities that should retain history.

Examples may include:

- Customers
- Facilities
- Bookings
- Transactions

Follow existing architecture.

---

# 58. DATABASE INTEGRITY

Use database constraints where appropriate.

Examples:

- Unique constraints
- Foreign keys
- Check constraints
- Non-null fields

Do not rely exclusively on UI validation for critical integrity.

---

# 59. DOCUMENT IMPORTANT ARCHITECTURAL CHANGES

If you introduce:

- New model
- New service
- New API
- New permission
- New environment variable
- New background job

document it clearly.

Do not produce unnecessary documentation for trivial changes.

---

# 60. DO NOT OVERWRITE MANUAL CUSTOMIZATION

Before changing existing UI, config, templates, or code, inspect whether there are manual customizations.

Preserve intentional custom behavior.

Do not replace working custom code with a generic implementation without understanding why it exists.

---

# 61. IMPLEMENTATION PROCESS

For every substantial task, use this workflow:

## Step 1 - Inspect

Understand relevant code and dependencies.

## Step 2 - Plan

Determine:

- What needs to change
- What should be reused
- Risks
- Dependencies
- Security impact
- Database impact

## Step 3 - Implement

Make focused changes.

## Step 4 - Validate

Run appropriate checks and tests.

## Step 5 - Review

Check:

- Duplication
- Security
- Permissions
- Responsiveness
- Edge cases
- Naming
- Dead code

## Step 6 - Report

Summarize:

- Files changed
- Main implementation
- Models/API changes
- Security considerations
- Tests performed
- Known limitations

---

# 62. WHEN REQUIREMENTS ARE AMBIGUOUS

Do not invent major business rules.

Use the existing project behavior as the first reference.

If an important requirement is genuinely unclear and implementing the wrong interpretation could affect:

- Data
- Security
- Booking logic
- Pricing
- Payments
- Permissions

stop and ask before making the high-impact change.

For minor implementation details, use sound engineering judgment.

---

# 63. NEVER CLAIM SOMETHING WAS VERIFIED IF IT WAS NOT

Do not say:

- Tested
- Working
- Verified
- Passed

unless the relevant check was actually performed.

If something could not be tested, state that clearly.

---

# 64. Global Table / Listing Standard

All existing and future listing pages must use one shared, reusable table/listing system wherever possible. Do not create separate table behavior per page.

Standard features should include, where applicable:

- Consistent global table styling
- Column sorting by clicking sortable column headers
- Resizable columns
- Drag/reorder columns similar to Odoo
- Clean row hover effects
- Row selection and bulk actions where relevant
- Global/page search
- Search menu with page-relevant filters
- Group By options based on the page data
- Clear active filter/group indicators
- Pagination
- Loading, empty, and error states
- Responsive behavior
- Permission-aware actions
- Persistent column preferences where appropriate

Search, Filter, Group By, sorting, column sizing/reordering, and table styling should be implemented through shared global components/utilities so improvements apply consistently across the project.

Before creating any new listing page, reuse the existing global table standard.

# 65. FINAL QUALITY CHECK

Before considering a task complete, ask:

- Did I inspect existing code first?
- Did I reuse existing functionality?
- Did I create any duplicate source of truth?
- Did I preserve security?
- Did I respect permissions?
- Did I preserve data isolation?
- Is the implementation understandable by another developer?
- Is it responsive?
- Did I consider edge cases?
- Did I introduce unnecessary complexity?
- Did I run appropriate checks?
- Did I accidentally use an em dash?
- Did I perform any prohibited Git/server/database operation?

If any answer is problematic, fix it before completing the task.


