import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bold, Italic, Underline, Strikethrough, List, ListOrdered, Link, Quote, RemoveFormatting,
} from 'lucide-react';

// Toolbar actions (execCommand-based). HTML output is sanitised server-side.
// `titleKey` rather than a literal: the tooltip has to follow the language.
export const RT_TOOLS = [
  { cmd: 'bold', icon: Bold, titleKey: 'richText.bold' },
  { cmd: 'italic', icon: Italic, titleKey: 'richText.italic' },
  { cmd: 'underline', icon: Underline, titleKey: 'richText.underline' },
  { cmd: 'strikeThrough', icon: Strikethrough, titleKey: 'richText.strikethrough' },
  { cmd: 'insertUnorderedList', icon: List, titleKey: 'richText.bulletList' },
  { cmd: 'insertOrderedList', icon: ListOrdered, titleKey: 'richText.numberedList' },
  { cmd: 'formatBlock', arg: 'blockquote', icon: Quote, titleKey: 'richText.quote' },
  { cmd: '__link', icon: Link, titleKey: 'richText.insertLink' },
  { cmd: 'removeFormat', icon: RemoveFormatting, titleKey: 'richText.clearFormatting' },
];

/**
 * Lightweight rich-text editor (contentEditable → HTML). Bold/italic/lists/links.
 * Output HTML is sanitised on the backend before storage. Controlled by `value`
 * (HTML string) + `onChange(html)`.
 */
export function RichTextEditor({ value, onChange, placeholder, minHeight = 180 }) {
  const { t } = useTranslation('common');
  const el = useRef(null);
  const savedRange = useRef(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');

  // Mirror the incoming `value` into the editor whenever it changes from the
  // outside (initial load, switching records), but never while the user is
  // actively typing in it - comparing against the live DOM avoids caret resets.
  useEffect(() => {
    const node = el.current;
    if (!node || document.activeElement === node) return;
    const incoming = value || '';
    if (node.innerHTML !== incoming) node.innerHTML = incoming;
  }, [value]);

  const emit = () => onChange(el.current?.innerHTML || '');

  // Enter inserts a single clean line break (a bare <br>, like Notepad) - no
  // paragraph wrappers, so there's no extra spacing above/below the new line.
  // Inside a list we keep the native behaviour (Enter = new list item).
  function onKeyDown(e) {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    let node = sel.anchorNode;
    while (node && node !== el.current) {
      if (node.nodeName === 'LI') return;
      node = node.parentNode;
    }
    e.preventDefault();
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const br = document.createElement('br');
    range.insertNode(br);
    // At the end of the content a trailing <br> isn't enough to show the caret
    // on the new line - add a sentinel <br> so the new line is visible.
    if (!br.nextSibling) br.after(document.createElement('br'));
    range.setStartAfter(br);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    emit();
  }

  function run(tool) {
    if (tool.cmd === '__link') {
      const sel = window.getSelection();
      savedRange.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      setLinkUrl(''); setLinkOpen(true);
      return;
    }
    el.current?.focus();
    document.execCommand(tool.cmd, false, tool.arg);
    emit();
  }
  function applyLink() {
    const url = linkUrl.trim();
    setLinkOpen(false);
    if (!url) return;
    el.current?.focus();
    const sel = window.getSelection();
    if (savedRange.current) { sel.removeAllRanges(); sel.addRange(savedRange.current); }
    document.execCommand('createLink', false, url);
    emit();
  }

  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, padding: 6, background: 'var(--color-surface-2, #f7f8fa)', borderBottom: '1px solid var(--color-border-soft, #eef0f4)' }}>
        {RT_TOOLS.map((tool) => {
          const Icon = tool.icon;
          return (
            <button key={tool.cmd} type="button" className="icon-btn" title={t(tool.titleKey)}
              onMouseDown={(e) => { e.preventDefault(); run(tool); }}>
              <Icon size={15} />
            </button>
          );
        })}
      </div>
      {linkOpen && (
        <div style={{ display: 'flex', gap: 8, padding: '8px 10px', background: '#fff', borderBottom: '1px solid var(--color-border-soft, #eef0f4)' }}>
          <input
            className="form-input" autoFocus placeholder="https://example.com" value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyLink(); } if (e.key === 'Escape') setLinkOpen(false); }}
            style={{ flex: 1 }}
          />
          <button type="button" className="btn btn-primary btn-sm" disabled={!linkUrl.trim()}
            onMouseDown={(e) => e.preventDefault()} onClick={applyLink}>{t('addLink')}</button>
          <button type="button" className="btn btn-secondary btn-sm"
            onMouseDown={(e) => e.preventDefault()} onClick={() => setLinkOpen(false)}>{t('common:actions.cancel')}</button>
        </div>
      )}
      <div
        ref={el} contentEditable suppressContentEditableWarning onInput={emit} onKeyDown={onKeyDown}
        data-ph={placeholder} className="rte-area"
        style={{ minHeight, padding: '10px 12px', fontSize: 14, lineHeight: 1.6, outline: 'none' }}
      />
    </div>
  );
}
