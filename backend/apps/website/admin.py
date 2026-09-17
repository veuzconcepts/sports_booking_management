from django.contrib import admin

from .models import (
    Banner,
    BrandLogo,
    FAQItem,
    FooterConfig,
    MediaAsset,
    ProcessStep,
    SEOSetting,
    SiteSection,
    StatItem,
    Testimonial,
    WhyChooseUsPoint,
)

_PUBLISH_LIST = ("is_enabled", "is_published", "display_order")


@admin.register(MediaAsset)
class MediaAssetAdmin(admin.ModelAdmin):
    list_display = ("title", "kind", "alt_text", "created_at")
    list_filter = ("kind",)
    search_fields = ("title", "alt_text")


@admin.register(SiteSection)
class SiteSectionAdmin(admin.ModelAdmin):
    list_display = ("key", "title", *_PUBLISH_LIST)
    list_filter = ("is_enabled", "is_published")


@admin.register(Banner)
class BannerAdmin(admin.ModelAdmin):
    list_display = ("heading", *_PUBLISH_LIST)
    list_filter = ("is_enabled", "is_published")


@admin.register(ProcessStep)
class ProcessStepAdmin(admin.ModelAdmin):
    list_display = ("step_no", "title", *_PUBLISH_LIST)


@admin.register(WhyChooseUsPoint)
class WhyChooseUsPointAdmin(admin.ModelAdmin):
    list_display = ("title", *_PUBLISH_LIST)


@admin.register(StatItem)
class StatItemAdmin(admin.ModelAdmin):
    list_display = ("value", "label", *_PUBLISH_LIST)


@admin.register(Testimonial)
class TestimonialAdmin(admin.ModelAdmin):
    list_display = ("author_name", "rating", *_PUBLISH_LIST)


@admin.register(BrandLogo)
class BrandLogoAdmin(admin.ModelAdmin):
    list_display = ("name", *_PUBLISH_LIST)


@admin.register(FAQItem)
class FAQItemAdmin(admin.ModelAdmin):
    list_display = ("question", *_PUBLISH_LIST)


@admin.register(FooterConfig)
class FooterConfigAdmin(admin.ModelAdmin):
    list_display = ("__str__", "newsletter_enabled", "updated_at")


@admin.register(SEOSetting)
class SEOSettingAdmin(admin.ModelAdmin):
    list_display = ("path", "meta_title", "robots", "updated_at")
    search_fields = ("path", "meta_title")
