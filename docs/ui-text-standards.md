# UI Text Standards

Conventions for every string a user can see: labels, messages, alerts, popups,
tooltips, buttons, table text, empty-state messages, validation messages,
notifications, admin-panel display text, and website copy (including CMS default /
seed content).

## Punctuation: no em dash

Do **not** use the em dash character `—` (U+2014). Use the plain keyboard
hyphen `-` (U+002D) instead.

- Correct: `That time slot was just taken - please pick another`
- Wrong:   `That time slot was just taken — please pick another`

This applies only to text visible to users. It does **not** change business logic,
database values, calculations, APIs, or backend processing.

## Where this is enforced

- **Frontend admin (`frontend/src`) and website (`web/src`)** - the em dash is
  never legitimate in these presentational trees, so a guard scans them:

  ```
  node scripts/check-no-emdash.mjs
  ```

  It exits non-zero and prints `file:line` for any em dash found. Wire it into CI
  or a pre-commit hook to keep new UI text compliant.

- **Backend (`backend/apps`)** - user-facing message strings (DRF `detail`,
  serializer `ValidationError` messages, loyalty/notification text, PDF text, and
  CMS seed/default content) must use the hyphen. Python **docstrings and code
  comments** are not user-facing and are exempt, so the backend is not scanned
  wholesale. When adding a user-facing string, use `-`, not `—`.
