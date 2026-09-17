import { useEffect, useState } from 'react';
import { ImagePlus, LibraryBig, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { Modal } from './Modal.jsx';
import { FormField } from './FormField.jsx';
import { ImageUploader } from './ImageUploader.jsx';
import { mediaApi } from '../services/websiteService.js';
import { useAuth } from '../hooks/useAuth.jsx';
import { apiErrorMessage } from '../utils/apiError.js';

/**
 * Pick a MediaAsset for a CMS image field - choose from the Media Library or
 * upload a new (cropped) image. Stores the asset id; surfaces { url, alt } for
 * preview.
 *
 * Props:
 *  - label, hint
 *  - value        selected MediaAsset id (or null)
 *  - detail       { url, alt } of the current asset (for preview)
 *  - onChange(id, detail)
 *  - aspect, output  passed to ImageUploader for the upload crop
 *  - kind         media kind to tag uploads with (image/icon/logo)
 */
export function MediaPicker({
  label, hint, value, detail, onChange,
  aspect = 1.5, output = { width: 1200, height: 800, type: 'image/jpeg', quality: 0.9 }, kind = 'image',
}) {
  const { t } = useTranslation('website');
  const { hasPerm } = useAuth();
  const canUpload = hasPerm('website.media');
  const [libOpen, setLibOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const preview = detail?.url || null;

  return (
    <FormField label={label} hint={hint}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{
          width: 96, height: 64, flexShrink: 0, borderRadius: 10, overflow: 'hidden',
          border: preview ? '1px solid var(--color-border)' : '1.5px dashed var(--color-border)',
          background: preview ? '#fff' : 'var(--color-border-soft)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)',
        }}>
          {preview
            ? <img src={preview} alt={detail?.alt || ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <ImagePlus size={20} />}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLibOpen(true)}>
              <LibraryBig size={14} /> {t('library')}
            </button>
            {canUpload && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setUploadOpen(true)}>
                <ImagePlus size={14} /> {t('common:actions.upload')}
              </button>
            )}
            {value && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange?.(null, null)}>
                <Trash2 size={14} /> {t('common:actions.remove')}
              </button>
            )}
          </div>
          <span className="muted" style={{ fontSize: 11.5 }}>{detail?.alt || 'No image selected'}</span>
        </div>
      </div>

      {libOpen && (
        <MediaLibraryModal
          onClose={() => setLibOpen(false)}
          onPick={(asset) => { onChange?.(asset.id, { url: asset.url, alt: asset.alt_text }); setLibOpen(false); }}
        />
      )}

      {uploadOpen && (
        <UploadModal
          aspect={aspect} output={output} kind={kind}
          onClose={() => setUploadOpen(false)}
          onUploaded={(asset) => { onChange?.(asset.id, { url: asset.url, alt: asset.alt_text }); setUploadOpen(false); }}
        />
      )}
    </FormField>
  );
}

function MediaLibraryModal({ onClose, onPick }) {
  const { t } = useTranslation('website');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    mediaApi.list({ page_size: 100 })
      .then((d) => setItems(d.results || d))
      .catch((e) => toast.error(apiErrorMessage(e, t('unableLoadMediaLibrary'))))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Modal open onClose={onClose} title={t('mediaLibrary')} size="lg"
      footer={<button className="btn btn-secondary" type="button" onClick={onClose}>{t('common:actions.close')}</button>}>
      {loading ? (
        <div className="muted" style={{ padding: 24 }}>Loading…</div>
      ) : items.length === 0 ? (
        <div className="muted" style={{ padding: 24 }}>{t('noMediaYetUploadImage')}</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 12 }}>
          {items.map((m) => (
            <button key={m.id} type="button" onClick={() => onPick(m)} title={m.title || m.alt_text}
              style={{ border: '1px solid var(--color-border)', borderRadius: 10, overflow: 'hidden',
                background: '#fff', cursor: 'pointer', padding: 0 }}>
              <div style={{ height: 90, background: 'var(--color-border-soft)' }}>
                {m.url && <img src={m.url} alt={m.alt_text || ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
              </div>
              <div style={{ padding: '6px 8px', fontSize: 12, textAlign: 'left', whiteSpace: 'nowrap',
                overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.title || m.alt_text || `#${m.id}`}</div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

function UploadModal({ aspect, output, kind, onClose, onUploaded }) {
  const { t } = useTranslation('website');
  const [file, setFile] = useState(null);
  const [alt, setAlt] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!file) { toast.error(t('chooseImageUpload')); return; }
    setBusy(true);
    try {
      const asset = await mediaApi.upload(file, { title, alt_text: alt, kind });
      toast.success(t('imageUploaded'));
      onUploaded(asset);
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableUploadImagePleaseTry')));
    } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={t('uploadImage')} size="md"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>{t('common:actions.cancel')}</button>
        <button className="btn btn-primary" type="button" onClick={submit} disabled={busy || !file}>
          {busy ? t('uploading') : t('common:actions.upload')}
        </button>
      </>}>
      <ImageUploader label={t('image')} aspect={aspect} output={output} file={file} onChange={setFile} />
      <FormField label={t('altText')} hint={t('describesImageSeoScreenReaders')}>
        <input className="form-input" value={alt} onChange={(e) => setAlt(e.target.value)} />
      </FormField>
      <FormField label={t('title')} hint={t('optionalLabelShownLibrary')}>
        <input className="form-input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </FormField>
    </Modal>
  );
}
