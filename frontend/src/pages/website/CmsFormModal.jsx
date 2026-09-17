import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import toast from 'react-hot-toast';

import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Toggle } from '../../components/Toggle.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { MediaPicker } from '../../components/MediaPicker.jsx';
import { apiErrorMessage } from '../../utils/apiError.js';

function defaultFor(f) {
  if (f.default !== undefined) return f.default;
  if (f.type === 'toggle') return true;
  if (f.type === 'bullets') return [];
  if (f.type === 'number') return 0;
  if (f.type === 'fk') return null;
  return '';
}

function BulletsEditor({ value, onChange }) {
  const list = Array.isArray(value) ? value : [];
  const setAt = (i, v) => onChange(list.map((x, idx) => (idx === i ? v : x)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {list.map((b, i) => (
        <div key={i} style={{ display: 'flex', gap: 6 }}>
          <input className="form-input" value={b} onChange={(e) => setAt(i, e.target.value)} />
          <button type="button" className="icon-btn" title="Remove"
            onClick={() => onChange(list.filter((_, idx) => idx !== i))}><X size={15} /></button>
        </div>
      ))}
      <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }}
        onClick={() => onChange([...list, ''])}><Plus size={14} /> Add</button>
    </div>
  );
}

function Field({ f, value, detail, fkOptions, onChange }) {
  if (f.type === 'toggle') {
    return (
      <div style={{ margin: '10px 0' }}>
        <Toggle label={f.label} description={f.hint}
          checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
      </div>
    );
  }
  if (f.type === 'media') {
    return (
      <MediaPicker label={f.label} hint={f.hint} value={value || null} detail={detail}
        aspect={f.aspect} output={f.output} kind={f.kind}
        onChange={(id, d) => onChange(id, d)} />
    );
  }
  if (f.type === 'bullets') {
    return <FormField label={f.label} hint={f.hint}><BulletsEditor value={value} onChange={onChange} /></FormField>;
  }
  if (f.type === 'select') {
    return (
      <FormField label={f.label} hint={f.hint}>
        <Select2 options={f.options} value={value} onChange={onChange} clearable={!f.required} />
      </FormField>
    );
  }
  if (f.type === 'fk') {
    return (
      <FormField label={f.label} hint={f.hint}>
        <Select2 options={fkOptions || []} value={value ?? ''} onChange={(v) => onChange(v || null)}
          clearable placeholder="None" />
      </FormField>
    );
  }
  if (f.type === 'textarea') {
    return (
      <FormField label={f.label} hint={f.hint}>
        <textarea className="form-textarea" rows={f.rows || 3} value={value ?? ''}
          onChange={(e) => onChange(e.target.value)} />
      </FormField>
    );
  }
  if (f.type === 'number') {
    return (
      <FormField label={f.label} hint={f.hint}>
        <input className="form-input" type="number" value={value ?? 0}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
      </FormField>
    );
  }
  return (
    <FormField label={f.label} hint={f.hint}>
      <input className="form-input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </FormField>
  );
}

export function CmsFormModal({ open, resource, record, onClose, onSaved }) {
  const fields = resource.fields;
  const isEdit = Boolean(record);
  const [form, setForm] = useState({});
  const [details, setDetails] = useState({});
  const [fkOptions, setFkOptions] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const init = {};
    const det = {};
    for (const f of fields) {
      const v = record?.[f.name];
      init[f.name] = v === undefined || v === null ? defaultFor(f) : v;
      if (f.type === 'media') det[f.name] = record?.[`${f.name}_detail`] || null;
    }
    setForm(init);
    setDetails(det);
    setFkOptions({});
    fields.filter((f) => f.type === 'fk').forEach((f) => {
      f.load().then((opts) => setFkOptions((o) => ({ ...o, [f.name]: opts }))).catch(() => {});
    });
  }, [open, record, fields]);

  function setField(name, v, d) {
    setForm((s) => ({ ...s, [name]: v }));
    if (d !== undefined) setDetails((s) => ({ ...s, [name]: d }));
  }

  async function submit() {
    for (const f of fields) {
      if (f.required) {
        const v = form[f.name];
        if (v === null || v === undefined || String(v).trim() === '') {
          toast.error(`${f.label} is required.`);
          return;
        }
      }
    }
    setBusy(true);
    try {
      const payload = {};
      for (const f of fields) payload[f.name] = form[f.name];
      const saved = isEdit
        ? await resource.api.update(record.id, payload)
        : await resource.api.create(payload);
      toast.success(isEdit ? `${resource.singular} saved` : `${resource.singular} created`);
      onSaved(saved);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to save. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} size={resource.modalSize || 'md'}
      title={`${isEdit ? 'Edit' : 'New'} ${resource.singular}`}
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" type="button" onClick={submit} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </>}>
      {fields.map((f) => (
        <Field key={f.name} f={f} value={form[f.name]} detail={details[f.name]} fkOptions={fkOptions[f.name]}
          onChange={(v, d) => setField(f.name, v, d)} />
      ))}
    </Modal>
  );
}
