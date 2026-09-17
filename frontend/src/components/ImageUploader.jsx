import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImagePlus, Crop, Trash2, X, ZoomIn } from 'lucide-react';
import toast from 'react-hot-toast';

import { FormField } from './FormField.jsx';

/**
 * Professional image upload field with fixed-aspect crop.
 *
 * Props:
 *  - label, hint
 *  - aspect            target aspect ratio (w / h), e.g. 3 for a 3:1 banner, 1 for a square icon
 *  - output            { width, height, type='image/jpeg', quality=0.92 } - exact exported size
 *  - currentUrl        existing image URL (edit mode)
 *  - file              currently-selected cropped File (controlled)
 *  - onChange(file)    called with the cropped File, or null when removed
 *  - maxSourceMB       reject source files larger than this (default 8)
 */
export function ImageUploader({
  label, hint, aspect = 1, output, currentUrl,
  file, onChange, maxSourceMB = 8, fit = 'cover', stack = false, noCrop = false,
}) {
  const out = { type: 'image/jpeg', quality: 0.92, ...output };
  const inputRef = useRef(null);
  const [rawSrc, setRawSrc] = useState(null);   // object URL of the source being cropped
  const [cropOpen, setCropOpen] = useState(false);
  const [preview, setPreview] = useState(currentUrl || null);

  // Keep a live preview URL for the selected (cropped) file.
  useEffect(() => {
    if (file) {
      const url = URL.createObjectURL(file);
      setPreview(url);
      return () => URL.revokeObjectURL(url);
    }
    setPreview(currentUrl || null);
    return undefined;
  }, [file, currentUrl]);

  // Tile dimensions follow the aspect ratio so the preview is never distorted.
  const tileH = 76;
  const tileW = Math.round(tileH * aspect);

  function pickFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';                       // allow re-selecting the same file
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast.error('Please choose an image file.'); return; }
    if (f.size > maxSourceMB * 1024 * 1024) { toast.error(`Image must be under ${maxSourceMB} MB.`); return; }
    if (noCrop) { onChange?.(f); return; }   // use the original image as-is (no crop/zoom)
    setRawSrc(URL.createObjectURL(f));
    setCropOpen(true);
  }

  function handleApply(croppedFile) {
    setCropOpen(false);
    if (rawSrc) { URL.revokeObjectURL(rawSrc); }
    onChange?.(croppedFile);
  }

  function handleRemove() {
    onChange?.(null);
    setPreview(null);
  }

  return (
    <FormField label={label} hint={hint}>
      <div style={{
        display: 'flex', gap: 14,
        flexDirection: stack ? 'column' : 'row',
        alignItems: stack ? 'stretch' : 'center',
      }}>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          title="Upload image"
          style={{
            // Stack mode: tile fills the column up to its natural width and keeps
            // aspect via aspect-ratio, so wide logos never overflow the column.
            width: stack ? '100%' : tileW,
            maxWidth: tileW, height: stack ? 'auto' : tileH,
            aspectRatio: stack ? String(aspect) : undefined,
            flexShrink: 0,
            borderRadius: 10, overflow: 'hidden', cursor: 'pointer',
            border: preview ? '1px solid var(--color-border)' : '1.5px dashed var(--color-border)',
            background: preview ? '#fff' : 'var(--color-border-soft)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--color-text-muted)', padding: 0,
          }}
        >
          {preview
            ? <img src={preview} alt="" style={{ width: '100%', height: '100%', objectFit: fit === 'contain' ? 'contain' : 'cover' }} />
            : <ImagePlus size={22} />}
        </button>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => inputRef.current?.click()}>
              <ImagePlus size={14} /> {preview ? 'Replace' : 'Upload'}
            </button>
            {rawSrc && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCropOpen(true)}>
                <Crop size={14} /> Re-crop
              </button>
            )}
            {preview && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={handleRemove}>
                <Trash2 size={14} /> Remove
              </button>
            )}
          </div>
          <span className="muted" style={{ fontSize: 11.5 }}>
            {noCrop
              ? `Uploaded as-is (keeps aspect) · PNG/JPG · max ${maxSourceMB}MB`
              : `${out.width}×${out.height}px · ${out.type === 'image/png' ? 'PNG' : 'JPG'} · max ${maxSourceMB}MB`}
          </span>
        </div>
      </div>

      <input ref={inputRef} type="file" accept="image/*" onChange={pickFile} style={{ display: 'none' }} />

      {cropOpen && rawSrc && (
        <CropOverlay
          src={rawSrc}
          aspect={aspect}
          output={out}
          fit={fit}
          fileName={`upload.${out.type === 'image/png' ? 'png' : 'jpg'}`}
          onCancel={() => setCropOpen(false)}
          onApply={handleApply}
        />
      )}
    </FormField>
  );
}

/* --------------------------------------------------------------------------
 * Crop overlay - drag to pan, slider to zoom; exports to an exact canvas size.
 * Rendered in its own portal above the form modal (z-index 1100).
 * ------------------------------------------------------------------------ */
function CropOverlay({ src, aspect, output, fit = 'cover', fileName, onCancel, onApply }) {
  // 'contain' fits the WHOLE image inside the frame (logos: nothing clipped,
  // transparent padding); 'cover' fills the frame, cropping the overflow.
  const fitScale = (vw, vh, w, h) =>
    (fit === 'contain' ? Math.min(vw / w, vh / h) : Math.max(vw / w, vh / h));
  const imgRef = useRef(null);
  const dragRef = useRef(null);
  const [nat, setNat] = useState(null);          // { w, h } natural size
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 }); // top-left of image within viewport
  const [busy, setBusy] = useState(false);

  // Viewport size (CSS px) - keep within the dialog.
  let VW = 460;
  let VH = VW / aspect;
  if (VH > 420) { VH = 420; VW = VH * aspect; }

  useEffect(() => {
    const im = new Image();
    im.onload = () => {
      imgRef.current = im;
      const bs = fitScale(VW, VH, im.naturalWidth, im.naturalHeight);
      const dW = im.naturalWidth * bs;
      const dH = im.naturalHeight * bs;
      setNat({ w: im.naturalWidth, h: im.naturalHeight });
      setZoom(1);
      setOff({ x: (VW - dW) / 2, y: (VH - dH) / 2 });   // center
    };
    im.onerror = () => toast.error('We were unable to load that image. Please choose another file.');
    im.src = src;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const baseScale = nat ? fitScale(VW, VH, nat.w, nat.h) : 1;
  const scale = baseScale * zoom;
  const dispW = nat ? nat.w * scale : 0;
  const dispH = nat ? nat.h * scale : 0;

  // Keep the image covering the frame while it's larger than the viewport; once
  // zoomed out smaller than the frame, centre it (so panning never strands it).
  const clamp = (x, y) => ({
    x: dispW <= VW ? (VW - dispW) / 2 : Math.min(0, Math.max(VW - dispW, x)),
    y: dispH <= VH ? (VH - dispH) / 2 : Math.min(0, Math.max(VH - dispH, y)),
  });

  // Re-clamp whenever the zoom changes so the image keeps covering the frame.
  useEffect(() => {
    if (nat) setOff((o) => clamp(o.x, o.y));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, nat]);

  function onPointerDown(e) {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: off.x, oy: off.y };
  }
  function onPointerMove(e) {
    if (!dragRef.current) return;
    const { sx, sy, ox, oy } = dragRef.current;
    setOff(clamp(ox + (e.clientX - sx), oy + (e.clientY - sy)));
  }
  function onPointerUp() { dragRef.current = null; }

  function apply() {
    if (!imgRef.current || !nat) return;
    setBusy(true);
    const canvas = document.createElement('canvas');
    canvas.width = output.width;
    canvas.height = output.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    if (output.type !== 'image/png') {
      ctx.fillStyle = '#ffffff';                 // flatten transparency for JPG
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const sx = -off.x / scale;
    const sy = -off.y / scale;
    const sW = VW / scale;
    const sH = VH / scale;
    ctx.drawImage(imgRef.current, sx, sy, sW, sH, 0, 0, output.width, output.height);
    canvas.toBlob(
      (blob) => {
        setBusy(false);
        if (!blob) { toast.error('We were unable to process that image. Please try a different file.'); return; }
        onApply(new File([blob], fileName, { type: output.type }));
      },
      output.type,
      output.quality,
    );
  }

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      background: 'rgba(15,23,42,0.6)', backdropFilter: 'blur(2px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div className="fade-in" style={{
        background: '#fff', borderRadius: 14, overflow: 'hidden',
        boxShadow: '0 24px 60px rgba(15,23,42,0.35)', maxWidth: '95vw',
      }}>
        <div className="modal-head">
          <h3 className="modal-title">Crop image</h3>
          <button className="icon-btn modal-close" onClick={onCancel} type="button" aria-label="Close">
            <X size={28} strokeWidth={2.25} />
          </button>
        </div>

        <div style={{ padding: '16px 18px' }}>
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            style={{
              position: 'relative', width: VW, height: VH, maxWidth: '100%',
              overflow: 'hidden', borderRadius: 10, background: '#e9e9ee',
              cursor: dragRef.current ? 'grabbing' : 'grab', touchAction: 'none',
              userSelect: 'none', margin: '0 auto',
            }}
          >
            {nat && (
              <img
                src={src} alt="" draggable={false}
                style={{
                  position: 'absolute',
                  left: off.x, top: off.y, width: dispW, height: dispH,
                  maxWidth: 'none', pointerEvents: 'none',
                }}
              />
            )}
            {/* grid guides - dark on the light background so any uncovered area is clear */}
            <div style={{
              position: 'absolute', inset: 0, pointerEvents: 'none',
              backgroundImage:
                'linear-gradient(rgba(0,0,0,.16) 1px, transparent 1px),' +
                'linear-gradient(90deg, rgba(0,0,0,.16) 1px, transparent 1px)',
              backgroundSize: `${VW / 3}px ${VH / 3}px`,
              boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.22)',
            }} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
            <ZoomIn size={16} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
            <input
              type="range" min="0.5" max="4" step="0.01"
              value={zoom} onChange={(e) => setZoom(Number(e.target.value))}
              style={{ flex: 1 }}
            />
          </div>
          <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
            Opens fully fitted to the frame · drag to reposition · slide to zoom in or out.
            Exports at {output.width}×{output.height}px.
          </p>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={apply} disabled={busy || !nat}>
            {busy ? 'Processing…' : 'Apply crop'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
