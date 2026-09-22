import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { notificationsApi } from '../services/notificationsService.js';

/**
 * Only ever navigate WITHIN this application.
 *
 * The one place a notification link is set is the server, as `/bookings/<id>`,
 * and the field is `read_only` on the API. This keeps it safe if either of
 * those ever changes: React Router treats a protocol-relative `//host`, and a
 * leading backslash, as somewhere else entirely, so an off-site value in that
 * column would become an open redirect that a member of staff has every reason
 * to click.
 *
 * One slash, then anything that is not another slash or a backslash.
 */
export function isInternalPath(link) {
  return typeof link === 'string' && /^\/(?![/\\])/.test(link);
}

// In-app notification bell: unread badge + a dropdown feed of the signed-in user's
// notifications (e.g. a refund awaiting their approval). Polls the unread count.
export function NotificationBell() {
  const { t } = useTranslation('notifications');
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('all');   // 'all' | 'unread' | 'read' - view only
  const ref = useRef(null);

  const loadCount = useCallback(() => {
    notificationsApi.unreadCount().then((d) => setUnread(d.unread || 0)).catch(() => {});
  }, []);

  useEffect(() => {
    loadCount();
    const t = setInterval(loadCount, 60000);   // refresh the badge each minute
    return () => clearInterval(t);
  }, [loadCount]);

  useEffect(() => {
    function onClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) notificationsApi.mine().then((d) => setItems(d.results || d || [])).catch(() => {});
  }

  // Client-side view filter (no change to what's fetched or marked read).
  const visible = items.filter((n) => (
    filter === 'all' ? true : filter === 'unread' ? !n.read_at : !!n.read_at
  ));

  /**
   * Only ever navigate WITHIN this application.
   *
   * The only place a notification link is set is the server, as
   * `/bookings/<id>`, and the field is read-only on the API. This keeps it
   * that way if either of those ever changes: React Router treats a leading
   * backslash, and a protocol-relative `//host`, as somewhere else entirely,
   * so an off-site link in that column would become an open redirect that a
   * member of staff has every reason to click.
   */
  function openItem(n) {
    if (!n.read_at) {
      notificationsApi.markRead(n.id).catch(() => {});
      setItems((xs) => xs.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
      setUnread((u) => Math.max(0, u - 1));
    }
    setOpen(false);
    if (isInternalPath(n.link)) navigate(n.link);
  }

  function markAll() {
    notificationsApi.markAllRead().catch(() => {});
    setItems((xs) => xs.map((x) => ({ ...x, read_at: x.read_at || new Date().toISOString() })));
    setUnread(0);
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="icon-btn" aria-label={t('title')} onClick={toggle} style={{ position: 'relative' }}>
        <Bell size={18} />
        {unread > 0 && (
          <span aria-label={`${unread} unread`} style={{
            position: 'absolute', top: 2, right: 2, minWidth: 16, height: 16, padding: '0 4px',
            borderRadius: 999, background: 'var(--color-danger,#dc2626)', color: '#fff',
            fontSize: 10, fontWeight: 700, lineHeight: '16px', textAlign: 'center',
          }}>{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', insetInlineEnd: 0, top: 'calc(100% + 8px)',
          width: 'min(340px, calc(100vw - 24px))', maxHeight: 'min(420px, 70vh)',
          overflowY: 'auto', background: 'var(--color-surface,#fff)', borderRadius: 10, zIndex: 50,
          border: '1px solid var(--color-border,#e5e7eb)', boxShadow: '0 8px 28px rgba(0,0,0,.14)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid var(--color-border,#eee)' }}>
            <strong style={{ fontSize: 13 }}>{t('title')}</strong>
            {unread > 0 && (
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={markAll}>{t('markAllRead')}</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--color-border,#f1f1f1)' }}>
            {[
              { key: 'all', label: t('common:state.all') },
              { key: 'unread', label: `Unread${unread ? ` (${unread})` : ''}` },
              { key: 'read', label: t('read') },
            ].map((tab) => (
              <button key={tab.key} type="button" onClick={() => setFilter(tab.key)} style={{
                fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
                border: '1px solid var(--color-border,#e5e7eb)',
                background: filter === tab.key ? 'var(--color-primary,#2563eb)' : 'transparent',
                color: filter === tab.key ? '#fff' : 'var(--color-text-muted)',
              }}>{tab.label}</button>
            ))}
          </div>
          {visible.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, padding: '16px 12px', margin: 0 }}>
              {filter === 'unread' ? "No unread notifications."
                : filter === 'read' ? "No read notifications."
                : "You're all caught up."}
            </p>
          ) : visible.map((n) => (
            <button key={n.id} onClick={() => openItem(n)} style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', cursor: 'pointer',
              border: 'none', borderBottom: '1px solid var(--color-border,#f1f1f1)',
              background: n.read_at ? 'transparent' : 'var(--color-info-bg,#eff6ff)',
            }}>
              <div style={{ fontSize: 13, fontWeight: n.read_at ? 500 : 700 }}>{n.subject}</div>
              {n.body && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{n.body}</div>}
              <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{new Date(n.created_at).toLocaleString()}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
