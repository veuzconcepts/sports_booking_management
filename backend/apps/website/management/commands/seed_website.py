"""Seed the customer-website CMS with starter homepage content.

Text only - images are uploaded later via the Media Library. Idempotent: every
record is matched on a natural key and updated in place, so re-running never
duplicates. All seeded content is enabled + published so the public endpoint
returns it immediately.

    python manage.py seed_website
"""

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.website.models import (
    Banner,
    BrandLogo,
    FAQItem,
    FooterConfig,
    ProcessStep,
    SEOSetting,
    SiteSection,
    StatItem,
    Testimonial,
    WhyChooseUsPoint,
)

PUB = {"is_enabled": True, "is_published": True}


def _published(defaults):
    d = dict(defaults)
    d.update(PUB)
    d["published_at"] = timezone.now()
    return d


SECTIONS = [
    ("hero", {"title": "Book your court in seconds",
              "subtitle": "Courts, pitches, lanes and halls - reserved online, any time.",
              "primary_button_label": "Book Now", "primary_button_url": "/book"}),
    ("how_it_works", {"eyebrow": "OUR PROCESS", "title": "How it works"}),
    ("why_choose_us", {"eyebrow": "WHY CHOOSE US",
                       "title": "Your club, always within reach",
                       "description": "Live availability, instant confirmation and one place to manage "
                                      "every booking you make with us.",
                       "primary_button_label": "About us", "primary_button_url": "/about"}),
    ("facilities", {"title": "What would you like to book today?"}),
    ("projects", {"eyebrow": "OUR CLUBS", "title": "Explore our venues"}),
    ("stats", {}),
    ("membership", {"eyebrow": "MEMBERSHIP", "title": "Save more with a membership"}),
    ("packages", {"eyebrow": "PACKAGES", "title": "Booking packages and add-ons"}),
    ("brands", {"eyebrow": "TRUSTED BY", "title": "Trusted partners"}),
    ("testimonials", {"eyebrow": "OUR MEMBERS SAY", "title": "Here are our trusted reviews"}),
    ("faq", {"eyebrow": "FAQS", "title": "Frequently Asked Questions"}),
    ("cta_band", {"title": "Ready to play? Let's get you booked.",
                  "primary_button_label": "Call Us Now", "primary_button_url": "tel:80012345678"}),
]

PROCESS = [
    ("01", "Choose a facility", "Pick the court, pitch, lane or room you want to book."),
    ("02", "Pick a time", "Live availability shows every free slot at your club."),
    ("03", "Confirm and pay", "Add any extras, apply a promo code and confirm in seconds."),
    ("04", "Turn up and play", "Check in at reception - your slot is reserved and ready."),
]

WHY = [
    ("Real-time availability", "Every slot you see is genuinely free - no double bookings."),
    ("Multiple clubs, one account", "Book at any of our venues from a single profile."),
    ("Flexible memberships", "Member rates and included sessions applied automatically."),
]

STATS = [("12", "Facilities"), ("2", "Clubs"),
         ("15k+", "Bookings taken"), ("3.4k+", "Active members")]

FAQS = [
    ("How do I book a facility?", "Tap Book Now, choose a club and facility, then pick a free time slot."),
    ("Can I book at more than one club?", "Yes - one account works across every club we operate."),
    ("How is pricing calculated?", "Pricing depends on the facility and any add-ons, and is shown before you confirm."),
    ("Can I cancel a booking?", "Contact the club and our team will help you cancel or reschedule."),
]

BRANDS = ["City Sports League", "Junior Academy", "Corporate Wellness", "Regional Federation"]


class Command(BaseCommand):
    help = "Seed the customer-website CMS with starter homepage content (text only)."

    def handle(self, *args, **options):
        for order, (key, defaults) in enumerate(SECTIONS):
            SiteSection.objects.update_or_create(
                key=key, defaults={**_published(defaults), "display_order": order})

        for order, (no, title, desc) in enumerate(PROCESS):
            ProcessStep.objects.update_or_create(
                step_no=no, defaults=_published({"title": title, "description": desc, "display_order": order}))

        for order, (title, desc) in enumerate(WHY):
            WhyChooseUsPoint.objects.update_or_create(
                title=title, defaults=_published({"description": desc, "display_order": order}))

        for order, (value, label) in enumerate(STATS):
            StatItem.objects.update_or_create(
                label=label, defaults=_published({"value": value, "display_order": order}))

        for order, (q, a) in enumerate(FAQS):
            FAQItem.objects.update_or_create(
                question=q, defaults=_published({"answer": a, "display_order": order}))

        for order, name in enumerate(BRANDS):
            BrandLogo.objects.update_or_create(
                name=name, defaults=_published({"display_order": order}))

        Testimonial.objects.update_or_create(
            author_name="Kende Attila",
            defaults=_published({
                "author_role": "Member", "rating": 4,
                "quote": "Booking a court used to mean three phone calls. Now it takes thirty "
                         "seconds and I can see exactly what is free.",
                "display_order": 0}))

        Banner.objects.update_or_create(
            heading="Book your court in seconds",
            defaults=_published({"subheading": "Live availability across every club and facility.",
                                 "cta_label": "Book Now", "cta_url": "/book", "display_order": 0}))

        footer = FooterConfig.get_solo()
        footer.about_text = ("Club and facility booking made simple. Check live availability, "
                             "reserve your slot and manage every booking in one place.")
        footer.link_columns = [
            {"title": "About Us", "links": [
                {"label": "About", "url": "/about"}, {"label": "Who we are", "url": "/about"},
                {"label": "Why choose us", "url": "/about"}, {"label": "Our clubs", "url": "/about"}]},
            {"title": "Facilities", "links": [
                {"label": "Tennis courts", "url": "/facilities"}, {"label": "Padel courts", "url": "/facilities"},
                {"label": "Football pitches", "url": "/facilities"}, {"label": "Function halls", "url": "/facilities"}]},
        ]
        footer.newsletter_enabled = True
        footer.newsletter_heading = "Sign up for email updates"
        footer.copyright_text = "(c) 2026 Club Booking | All Rights Reserved"
        footer.bottom_links = [{"label": "Terms", "url": "/terms"},
                               {"label": "Privacy", "url": "/privacy"},
                               {"label": "Refund Policy", "url": "/refund-policy"}]
        footer.save()

        SEOSetting.objects.update_or_create(
            path="/", defaults={
                "meta_title": "Club & Facility Booking",
                "meta_description": "Book courts, pitches, lanes, halls and meeting spaces at our "
                                    "clubs. Live availability and instant confirmation.",
                "robots": "index,follow"})

        self.stdout.write(self.style.SUCCESS("Website CMS seeded (text content)."))
