"""Spreading one payment across the slots of a multi-slot order.

`allocate_across` is the only place a single share becomes several payments, so
it is tested on its own: an error here would not crash anything, it would just
quietly charge the wrong slot the wrong amount.

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


def test_an_even_split_across_even_slots():
    slots = [FakeSlot(100), FakeSlot(100)]
    allocation = allocate_across(slots, Decimal("100"), "SAR")
    assert total_of(allocation) == Decimal("100")
    assert [part for _b, part in allocation] == [Decimal("50.00"), Decimal("50.00")]


def test_an_odd_amount_still_adds_back_exactly():
    """100 across three slots is 33.33 three times, which is a cent short.

    The leftover has to land somewhere rather than evaporating.
    """
    slots = [FakeSlot(100), FakeSlot(100), FakeSlot(100)]
    allocation = allocate_across(slots, Decimal("100"), "SAR")
    assert total_of(allocation) == Decimal("100")
    assert len(allocation) == 3


def test_the_split_follows_price_not_headcount():
    """Slots are not equally priced, so an equal split would be wrong.

    A peak evening costs more than an afternoon, and refunding the cheap slot
    later has to return what was actually paid for it.
    """
    slots = [FakeSlot(300), FakeSlot(100)]
    allocation = allocate_across(slots, Decimal("200"), "SAR")
    assert total_of(allocation) == Decimal("200")
    assert [part for _b, part in allocation] == [Decimal("150.00"), Decimal("50.00")]


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


@pytest.mark.parametrize("amount", ["0.01", "1", "7.77", "33.33", "99.99", "250"])
def test_the_parts_always_add_back(amount):
    slots = [FakeSlot(120), FakeSlot(80), FakeSlot(55), FakeSlot(45)]
    allocation = allocate_across(slots, Decimal(amount), "SAR")
    assert total_of(allocation) == Decimal(amount).quantize(Decimal("0.01"))
