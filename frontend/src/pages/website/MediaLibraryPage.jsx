import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { ImageUploader } from '../../components/ImageUploader.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { mediaApi, MEDIA_KINDS } from '../../services/websiteService.js';
import { apiErrorMessage } from '../../utils/apiError.js';

export default function MediaLibraryPage() {
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
      .catch((e) => toast.error(apiErrorMessage(e, 'Unable to load the media library.')))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function doDelete() {
    if (!toDelete) return;
    setBusy(true);
    try {
      await mediaApi.remove(toDelete.id);
      toast.success('Media deleted');
      setToDelete(null);
      load();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to delete this media. It may be in use.'));
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader
        title="Media Library"
        subtitle="Images, icons and logos used across the website."
        actions={canUpload && (
          <button className="btn btn-primary" onClick={() => setUploadOpen(true)}>
            <Plus size={15} /> Upload media
          </button>
        )}
      />

      {loading ? (
        <div className="card"><div className="table-state center"><span className="muted">Loading…</span></div></div>
      ) : items.length === 0 ? (
        <div className="card"><div className="empty"><h3>No media yet</h3><p>Upload images to use across the club.</p></div></div>
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
                    onClick={() => setToDelete(m)}><Trash2 size={13} /> Delete</button>
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
        open={Boolean(toDelete)} tone="danger" title="Delete media?" confirmLabel="Delete" busy={busy}
        message={toDelete ? 'Remove this asset from the library. Sections still referencing it will show no image.' : ''}
        onConfirm={doDelete}
        onClose={() => { if (!busy) setToDelete(null); }}
      />
    </>
  );
}

function UploadModal({ onClose, onUploaded }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [alt, setAlt] = useState('');
  const [kind, setKind] = useState('image');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!file) { toast.error('Choose an image to upload.'); return; }
    setBusy(true);
    try {
      await mediaApi.upload(file, { title, alt_text: alt, kind });
      toast.success('Media uploaded');
      onUploaded();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to upload. Please try again.'));
    } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="Upload media" size="md"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" type="button" onClick={submit} disabled={busy || !file}>
          {busy ? 'Uploading…' : 'Upload'}
        </button>
      </>}>
      <ImageUploader label="Image" aspect={1.5}
        output={{ width: 1200, height: 800, type: 'image/jpeg', quality: 0.9 }}
        file={file} onChange={setFile} />
      <FormField label="Kind">
        <Select2 options={MEDIA_KINDS} value={kind} onChange={setKind} />
      </FormField>
      <FormField label="Alt text" hint="Describes the image for SEO and screen readers.">
        <input className="form-input" value={alt} onChange={(e) => setAlt(e.target.value)} />
      </FormField>
      <FormField label="Title" hint="Optional label shown in the library.">
        <input className="form-input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </FormField>
    </Modal>
  );
}
