import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { ImageUploader } from '../../components/ImageUploader.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { mediaApi, mediaKinds } from '../../services/websiteService.js';
import { apiErrorMessage } from '../../utils/apiError.js';

export default function MediaLibraryPage() {
  const { t } = useTranslation('website');
  const { hasPerm } = useAuth();
  const canUpload = hasPerm('website.media');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [toDelete, setToDelete] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    mediaApi.list({ page_size: 200 })
      .then((d) => setItems(d.results || d))
      .catch((e) => toast.error(apiErrorMessage(e, t('unableLoadMediaLibrary'))))
      .finally(() => setLoading(false));
  }, [t]);
  useEffect(() => { load(); }, [load]);

  async function doDelete() {
    if (!toDelete) return;
    setBusy(true);
    try {
      await mediaApi.remove(toDelete.id);
      toast.success(t('mediaDeleted'));
      setToDelete(null);
      load();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableDeleteMediaItMay')));
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader
        title={t('mediaLibrary')}
        subtitle={t('imagesIconsLogosUsedAcross')}
        actions={canUpload && (
          <button className="btn btn-primary" onClick={() => setUploadOpen(true)}>
            <Plus size={15} /> {t('uploadMedia')}
          </button>
        )}
      />

      {loading ? (
        <div className="card"><div className="table-state center"><span className="muted">Loading…</span></div></div>
      ) : items.length === 0 ? (
        <div className="card"><div className="empty"><h3>{t('noMediaYet')}</h3><p>{t('uploadImagesUseAcrossClub')}</p></div></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 14 }}>
          {items.map((m) => (
            <div key={m.id} className="card" style={{ overflow: 'hidden' }}>
              <div style={{ height: 110, background: 'var(--color-border-soft)' }}>
                {m.url && <img src={m.url} alt={m.alt_text || ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
              </div>
              <div style={{ padding: '8px 10px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {m.title || m.alt_text || `#${m.id}`}
                </div>
                <div className="muted" style={{ fontSize: 11, textTransform: 'capitalize' }}>{m.kind}</div>
                {canUpload && (
                  <button className="btn btn-secondary btn-sm" style={{ marginTop: 6 }}
                    onClick={() => setToDelete(m)}><Trash2 size={13} /> {t('common:actions.delete')}</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {uploadOpen && (
        <UploadModal onClose={() => setUploadOpen(false)} onUploaded={() => { setUploadOpen(false); load(); }} />
      )}

      <ConfirmDialog
        open={Boolean(toDelete)} tone="danger" title={t('deleteMedia')} confirmLabel={t('common:actions.delete')} busy={busy}
        message={toDelete ? 'Remove this asset from the library. Sections still referencing it will show no image.' : ''}
        onConfirm={doDelete}
        onClose={() => { if (!busy) setToDelete(null); }}
      />
    </>
  );
}

function UploadModal({ onClose, onUploaded }) {
  const { t } = useTranslation('website');
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [alt, setAlt] = useState('');
  const [kind, setKind] = useState('image');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!file) { toast.error(t('chooseImageUpload')); return; }
    setBusy(true);
    try {
      await mediaApi.upload(file, { title, alt_text: alt, kind });
      toast.success(t('mediaUploaded'));
      onUploaded();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableUploadPleaseTryAgain')));
    } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={t('uploadMedia')} size="md"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>{t('common:actions.cancel')}</button>
        <button className="btn btn-primary" type="button" onClick={submit} disabled={busy || !file}>
          {busy ? t('uploading') : t('common:actions.upload')}
        </button>
      </>}>
      <ImageUploader label={t('image')} aspect={1.5}
        output={{ width: 1200, height: 800, type: 'image/jpeg', quality: 0.9 }}
        file={file} onChange={setFile} />
      <FormField label={t('kind')}>
        <Select2 options={mediaKinds(t)} value={kind} onChange={setKind} />
      </FormField>
      <FormField label={t('altText')} hint={t('describesImageSeoScreenReaders')}>
        <input className="form-input" value={alt} onChange={(e) => setAlt(e.target.value)} />
      </FormField>
      <FormField label={t('title')} hint={t('optionalLabelShownLibrary')}>
        <input className="form-input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </FormField>
    </Modal>
  );
}
