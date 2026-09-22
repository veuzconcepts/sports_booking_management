"""Landing one payment on the slots of a multi-slot order.

`allocate_across` is the only place a single share becomes several payments, so
it is tested on its own: an error here would not crash anything, it would just
quietly charge the wrong slot the wrong amount.

Confirmed policy is that a share settles WHOLE SLOTS, earliest first, rather
than taking a slice of each. Spreading proportionally was also arithmetically
correct, but three friends settling three slots produced nine payments and
nine invoices, and left every slot part paid until the last person paid.

The invariant that matters in every case is the same one: the parts must add
back to exactly the amount charged, and no part may exceed what its slot still
owes.
"""

from decimal import Decimal

import pytest

from apps.payments.split import allocate_across

# No database: the allocator only reads an outstanding balance, which is
# stubbed below, so these stay pure arithmetic tests.


class FakeSlot:
    """Just enough booking for the allocator: an id and an outstanding balance.

    A real booking would need a club, a facility type and a schedule, none of
    which this function looks at.
    """

    def __init__(self, due):
        self.due = Decimal(str(due))
        self.currency = "SAR"


@pytest.fixture(autouse=True)
def _outstanding(monkeypatch):
    monkeypatch.setattr("apps.bookings.services.booking_outstanding",
                        lambda booking: booking.due)


def total_of(allocation):
    return sum((part for _booking, part in allocation), Decimal("0"))


def test_a_share_settles_one_whole_slot():
    """The case the whole policy exists for: three equal slots, three friends.

    Each payment clears exactly one slot, so that slot has ONE payer, raises
    ONE invoice and confirms itself straight away.
    """
    slots = [FakeSlot(100), FakeSlot(100), FakeSlot(100)]
    allocation = allocate_across(slots, Decimal("100"), "SAR")
    assert total_of(allocation) == Decimal("100")
    assert len(allocation) == 1
    assert allocation[0][0] is slots[0]


def test_it_fills_the_earliest_slots_first():
    """Chronological, so which slot a payment lands on is the same every run
    and reads the way the customer booked them."""
    slots = [FakeSlot(100), FakeSlot(100), FakeSlot(100)]
    allocation = allocate_across(slots, Decimal("250"), "SAR")
    assert total_of(allocation) == Decimal("250")
    assert [b for b, _p in allocation] == [slots[0], slots[1], slots[2]]
    assert [part for _b, part in allocation] == [
        Decimal("100.00"), Decimal("100.00"), Decimal("50.00")]


def test_only_the_slot_the_money_runs_out_on_is_left_part_paid():
    slots = [FakeSlot(100), FakeSlot(100)]
    allocation = allocate_across(slots, Decimal("150"), "SAR")
    assert total_of(allocation) == Decimal("150")
    assert [part for _b, part in allocation] == [Decimal("100.00"), Decimal("50.00")]


def test_an_odd_amount_still_adds_back_exactly():
    """A share that does not divide into the slot prices must not lose or
    invent a fraction of a riyal on the way."""
    slots = [FakeSlot("33.33"), FakeSlot("33.33"), FakeSlot("33.34")]
    allocation = allocate_across(slots, Decimal("50"), "SAR")
    assert total_of(allocation) == Decimal("50")
    assert [part for _b, part in allocation] == [Decimal("33.33"), Decimal("16.67")]


def test_slots_priced_differently_are_still_settled_whole():
    """A peak evening costs more than an afternoon. The expensive slot is
    cleared outright before the cheap one is touched."""
    slots = [FakeSlot(300), FakeSlot(100)]
    allocation = allocate_across(slots, Decimal("300"), "SAR")
    assert total_of(allocation) == Decimal("300")
    assert len(allocation) == 1
    assert allocation[0][0] is slots[0]


def test_no_slot_is_ever_allocated_more_than_it_owes():
    slots = [FakeSlot(10), FakeSlot(1000)]
    allocation = allocate_across(slots, Decimal("1010"), "SAR")
    for booking, part in allocation:
        assert part <= booking.due
    assert total_of(allocation) == Decimal("1010")


def test_paying_everything_clears_every_slot():
    slots = [FakeSlot("33.33"), FakeSlot("66.67")]
    allocation = allocate_across(slots, Decimal("100.00"), "SAR")
    assert total_of(allocation) == Decimal("100.00")
    assert len(allocation) == 2


def test_a_settled_slot_is_skipped_rather_than_charged_zero():
    slots = [FakeSlot(0), FakeSlot(100)]
    allocation = allocate_across(slots, Decimal("40"), "SAR")
    assert len(allocation) == 1
    assert allocation[0][0] is slots[1]


def test_nothing_owed_allocates_nothing():
    assert allocate_across([FakeSlot(0)], Decimal("50"), "SAR") == []


def test_nothing_offered_allocates_nothing():
    assert allocate_across([FakeSlot(100)], Decimal("0"), "SAR") == []


def test_a_tiny_amount_lands_on_one_slot_rather_than_splitting_to_zero():
    """Below one minor unit per slot the money must not disappear."""
    slots = [FakeSlot(100), FakeSlot(100), FakeSlot(100)]
    allocation = allocate_across(slots, Decimal("0.01"), "SAR")
    assert total_of(allocation) == Decimal("0.01")
    assert len(allocation) == 1


def test_three_friends_settling_three_slots_raise_three_payments():
    """The row count that started this. Each friend's share is applied to the
    balances left by the one before, and the order ends with one payment per
    slot rather than one per slot per payer."""
    slots = [FakeSlot(100), FakeSlot(100), FakeSlot(100)]
    payments = 0
    for _friend in range(3):
        allocation = allocate_across(slots, Decimal("100"), "SAR")
        payments += len(allocation)
        for booking, part in allocation:
            booking.due -= part
    assert payments == 3
    assert all(slot.due == 0 for slot in slots)


@pytest.mark.parametrize("amount", ["0.01", "1", "7.77", "33.33", "99.99", "250"])
def test_the_parts_always_add_back(amount):
    slots = [FakeSlot(120), FakeSlot(80), FakeSlot(55), FakeSlot(45)]
    allocation = allocate_across(slots, Decimal(amount), "SAR")
    assert total_of(allocation) == Decimal(amount).quantize(Decimal("0.01"))
