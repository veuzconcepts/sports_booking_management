import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The campaign card as the customer will see it, rendered from the draft.
 *
 * A deliberate copy of the website's card rather than an import of it: the two
 * live in separate applications (this is the admin bundle, the card ships with
 * the Astro site) and sharing a component across that boundary would mean
 * publishing one to depend on the other. The shape it is previewing is the
 * campaign record, which both read, so the two cannot drift on what a campaign
 * IS - only on how it looks, which is what the preview is for checking.
 *
 * It is inert: no links are followed, nothing is counted, nothing is saved.
 */

const WIDTHS = { desktop: 620, tablet: 480, mobile: 320 };

export function CampaignPreview({
  campaign, image, mobileImage, promoLabel, device = 'desktop', dark = false,
}) {
  const { t } = useTranslation('website');

  // A phone shows the portrait artwork when there is one, exactly as the site
  // does; without one it falls back to the main image rather than cropping.
  const art = device === 'mobile' ? (mobileImage || image) : image;
  const wordy = Boolean(campaign.title || campaign.subtitle || campaign.description
    || campaign.cta_label);

  return (
    <div className={`cmpp${dark ? ' cmpp--dark' : ''}`} data-device={device}>
      <div className="cmpp__frame" style={{ width: WIDTHS[device] }}>
        <div className={`cmpp__card${art && wordy ? ' cmpp__card--split' : ''}`}>
          {campaign.dismissible !== false && (
            <span className="cmpp__close" aria-hidden="true"><X size={14} /></span>
          )}

          {art ? (
            <div className="cmpp__art">
              <img src={art.url} alt={campaign.alt_text || ''} />
            </div>
          ) : null}

          {wordy && (
            <div className="cmpp__body">
              {promoLabel && <span className="cmpp__code">{promoLabel}</span>}
              {campaign.title && <h4 className="cmpp__title">{campaign.title}</h4>}
              {campaign.subtitle && <p className="cmpp__sub">{campaign.subtitle}</p>}
              {campaign.description && <p className="cmpp__desc">{campaign.description}</p>}
              <div className="cmpp__actions">
                {campaign.cta_label && (
                  <span className="cmpp__btn cmpp__btn--primary">{campaign.cta_label}</span>
                )}
                {campaign.secondary_cta_label && (
                  <span className="cmpp__btn">{campaign.secondary_cta_label}</span>
                )}
              </div>
            </div>
          )}

          {!art && !wordy && (
            <div className="cmpp__blank">{t('campaigns.previewEmpty')}</div>
          )}
        </div>
      </div>
    </div>
  );
}
