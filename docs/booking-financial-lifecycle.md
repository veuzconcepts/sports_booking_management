# Booking Financial Lifecycle — Rules & State Matrix

How a booking's **subscription coverage**, **invoice**, and **payment** interact, and what is
allowed or blocked at each stage. The overriding rule: **no booking may ever receive both a
captured payment and free subscription coverage for the same service** — no double benefit, no
revenue leakage, no inconsistent documents.

## Source of truth

A booking's settlement is read from **real `Payment`/`Invoice` rows**, never from the
`booking.payment_status` field alone (that field is kept in sync as a convenience but can drift).
Helpers in `apps/bookings/services.py`:

- `booking_payment_taken(booking)` — money is captured if a `Payment` or `Invoice` is `PAID` or
  `PARTIALLY_REFUNDED` (fully `REFUNDED`/`CANCELLED` does **not** count — reversal frees the lock).
- `coverage_change_locked(booking)` — the single gate for redeem/unapply (terminal status **or**
  payment taken → locked).
- `sync_booking_payment_status(booking)` — re-derives the field from the ledger after any money
  movement (capture in `charge`/`mark_invoice_paid`; reversal in `_process_credit_note`).

## State transition matrix

Booking status groups — **active** = Created/Confirmed/Assigned/Service-started; **final** =
Completed/Closed; **void** = Cancelled/No-show.

| Action | Active, no payment | Active, UNPAID invoice | Active, PAID / captured | Final / Void |
|---|---|---|---|---|
| **Apply subscription (redeem)** | ✅ | ✅ — auto-cancel the unpaid invoice, re-price to covered | ⛔ blocked — refund/credit-note first | ⛔ blocked |
| **Remove subscription (unapply)** | ✅ | ✅ — auto-cancel the unpaid invoice, re-price to full | ⛔ blocked — refund first | ⛔ blocked |
| **Generate invoice** | ✅ if payable > 0; ⛔ if covered/0 | idempotent (returns the live one) | idempotent | final = completion invoice; ⛔ on void |
| **Accept payment** | ✅ if payable > 0 | ✅ pays that invoice | idempotent | ⛔ |
| **Financial values (coverage + price)** | mutable | mutable (document auto-managed) | **LOCKED** | **LOCKED** |

## Stage rules

- **Subscription may be applied/removed** only while the booking is *active* **and** no payment
  has been captured. An unpaid (Issued) invoice is auto-cancelled by the action (safe — no money
  moved); a captured payment locks coverage until an explicit refund/credit-note.
- **An invoice may be generated** only when payable > 0 (a fully-covered booking is refused with
  "Nothing to invoice…") and the booking isn't void.
- **A payment may be accepted** only against a payable (> 0) booking/invoice.
- **Financial values lock** the moment a payment is captured (coverage frozen) and again at
  Completed/Closed (everything frozen). The only way back is the refund/credit-note flow.
- **Reversal** (credit-note → refund) sets the invoice/payment to refunded, which un-locks the
  booking so coverage can change again.

## Audit

Every financial-impacting action records the actor, before→after amount, before→after payment
status, document impact (e.g. `cancelled_invoices`), reason, and timestamp — in the Booking Log
(`BookingStatusHistory.meta`) and the `AuditLog`.

## Enforcement map

| Rule | Where |
|---|---|
| Coverage lock (redeem/unapply gate) | `BookingViewSet._subscription_change_guard` → `coverage_change_locked` |
| Auto-cancel unpaid invoice on coverage change | `BookingViewSet._cancel_unpaid_invoices` |
| Block 0-payable invoice | `payments.services.create_invoice` (booking path) |
| Field kept truthful to the ledger | `_sync_booking_payment` in `charge` / `mark_invoice_paid` / `_process_credit_note`; `reopen_booking` |
| Don't silently re-price a paid booking | `payments.services.revalidate_booking_coverage` early-out |
| UI never offers a blocked Redeem | `BookingSerializer.get_eligible_subscription` / `get_coverage_state` |
| Completion requires payment when owed | `bookings.services._validate_completion_gate` |
