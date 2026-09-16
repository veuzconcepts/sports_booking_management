import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { useAuth } from '../../hooks/useAuth.jsx';
import { useTabParam } from '../../hooks/useTabParam.js';
import { formatMoney as fmtMoney, Money } from '../../services/currency.jsx';
import { customersApi } from '../../services/customersService.js';
import { facilityTypesApi, facilityCategoriesApi, addonsApi } from '../../services/facilitiesService.js';
import { clubsApi } from '../../services/clubsService.js';
import {
  MEMBERSHIP_INTERVALS, VALIDITY_MODES, ENTITLEMENT_TARGETS, ENTITLEMENT_LIMITS,
  ENTITLEMENT_PERIODS, MEMBERSHIP_STATUS_TONE, MEMBERSHIP_STATUS_LABELS,
  MEMBERSHIP_PAYMENT_METHODS, membershipPlansApi, membershipsApi,
} from '../../services/subscriptionsService.js';
import { apiErrorMessage } from '../../utils/apiError';

const TABS = [
  { key: 'memberships', label: 'Memberships' },
  { key: 'plans',       label: 'Plans' },
];

const tabBtnStyle = (active) => ({
  padding: '8px 14px', border: 'none', background: 'transparent',
  borderBottom: active ? '2px solid var(--color-primary-600)' : '2px solid transparent',
  color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
  fontWeight: 600, fontSize: 13.5, cursor: 'pointer',
});

const intervalLabel = (v) => (MEMBERSHIP_INTERVALS.find((i) => i.value === v)?.label || v);

// Friendly labels for the subscription activity timeline (audit events).
const EVENT_LABELS = {
  membership_issued: 'Issued', membership_renewed: 'Renewed',
  membership_suspended: 'Suspended', membership_resumed: 'Resumed',
  membership_cancelled: 'Cancelled', membership_extended: 'Extended',
  membership_expired: 'Expired', membership_usage_adjusted: 'Usage adjusted',
  membership_plan_created: 'Plan created', membership_plan_updated: 'Plan updated',
};
const eventLabel = (e) => EVENT_LABELS[e] || (e || '').replace(/_/g, ' ');

function ActivityTimeline({ rows }) {
  if (!rows) return <p className="muted" style={{ fontSize: 13 }}>Loading…</p>;
  if (rows.length === 0) return <p className="muted" style={{ fontSize: 13 }}>No activity yet.</p>;
  return (
    <div style={{ maxHeight: 200, overflow: 'auto' }}>
      {rows.map((r) => {
        const p = r.payload_summary || {};
        const detail = [p.reason, p.note, p.from && p.to ? `${p.from} → ${p.to}` : null,
          p.invoice ? `Invoice ${p.invoice}` : null].filter(Boolean).join(' · ');
        return (
          <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10,
            fontSize: 12.5, padding: '4px 0', borderTop: '1px solid var(--color-border,#eee)' }}>
            <span>
              <strong>{eventLabel(r.event)}</strong>
              {detail ? <span className="muted"> - {detail}</span> : null}
              {r.actor_name ? <span className="muted"> · by {r.actor_name}</span>
                : (p.system ? <span className="muted"> · system</span> : null)}
            </span>
            <span className="muted" style={{ whiteSpace: 'nowrap' }}>
              {new Date(r.created_at).toLocaleString()}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function SubscriptionsPage() {
  const [tab, setTab] = useTabParam('memberships');
  return (
    <>
      <PageHeader
        title="Subscriptions"
        subtitle="Membership plans (entitlements) and the customer subscriptions issued against them."
      />
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border)', marginBottom: 18 }}>
        {TABS.map((t) => (
          <button key={t.key} style={tabBtnStyle(tab === t.key)} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === 'memberships' && <MembershipsTab />}
      {tab === 'plans' && <PlansTab />}
    </>
  );
}

/* --------------------------- Memberships tab --------------------------- */
function MembershipsTab() {
  const { hasPerm } = useAuth();
  const [issueOpen, setIssueOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const fetcher = useCallback((q) => membershipsApi.list(q), []);
  const { rows, loading, reload } = useApiList(fetcher);

  const columns = [
    { key: 'number', header: 'Membership', render: (r) => <span style={{ fontWeight: 600 }}>{r.number || '-'}</span> },
    { key: 'customer', header: 'Customer', render: (r) => r.customer_name },
    { key: 'plan', header: 'Plan', render: (r) => r.plan_name },
    { key: 'period', header: 'Period', render: (r) => `${new Date(r.start_date).toLocaleDateString()} - ${new Date(r.end_date).toLocaleDateString()}` },
    { key: 'status', header: 'Status', render: (r) => (
      <StatusBadge tone={MEMBERSHIP_STATUS_TONE[r.status] || 'muted'}
        label={MEMBERSHIP_STATUS_LABELS[r.status] || r.status} />
    ) },
  ];

  return (
    <>
      {hasPerm('subscriptions.assign') && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button className="btn btn-primary" onClick={() => setIssueOpen(true)}><Plus size={15} /> Issue membership</button>
        </div>
      )}
      <DataTable
        loading={loading}
        rows={rows}
        onRowClick={(r) => setDetailId(r.id)}
        emptyTitle="No memberships yet"
        emptyHint="Issue a membership to a customer from a plan."
        columns={columns}
      />
      <IssueMembershipModal open={issueOpen} onClose={() => setIssueOpen(false)}
        onDone={() => { setIssueOpen(false); toast.success('Membership issued'); reload(); }} />
      <MembershipDetailModal id={detailId} onClose={() => setDetailId(null)} onChanged={reload} />
    </>
  );
}

function MembershipDetailModal({ id, onClose, onChanged }) {
  const { hasPerm } = useAuth();
  const [m, setM] = useState(null);
  const [usage, setUsage] = useState([]);
  const [activity, setActivity] = useState(null);
  const [busy, setBusy] = useState(false);
  const [extendDays, setExtendDays] = useState('30');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  // Generic confirmation guard so a misclick on a lifecycle / finance action
  // (renew charges money) can never save without an explicit confirm.
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(() => {
    if (!id) return;
    membershipsApi.get(id).then(setM).catch(() => {});
    membershipsApi.usage(id, { page_size: 25 }).then((d) => setUsage(d.results || d)).catch(() => {});
    membershipsApi.activity(id, { page_size: 50 }).then((d) => setActivity(d.results || d)).catch(() => setActivity([]));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function act(fn, okMsg) {
    setBusy(true);
    try { await fn(); toast.success(okMsg); load(); onChanged?.(); }
    catch (e) { toast.error(apiErrorMessage(e, 'Action failed. Please try again.')); }
    finally { setBusy(false); }
  }
  // Ask before running a state-changing action; `run` fires only on confirm.
  const ask = (opts, run) => setConfirm({ ...opts, run });

  if (!id) return null;
  // Backend-computed current-period status per entitlement (remaining already
  // accounts for granted bonus + reserved holds - no client-side period maths).
  const statusFor = (entId) => (m?.entitlement_status || []).find((s) => s.entitlement === entId) || {};
  const entLabel = (e) => e.facility_type_name || e.facility_category_name || e.addon_name || '-';
  const canSuspend = hasPerm('subscriptions.suspend');
  const canCancel = hasPerm('subscriptions.cancel');
  const canEdit = hasPerm('subscriptions.edit');
  const canAdjust = hasPerm('subscriptions.usage_adjust');

  return (
    <>
      <Modal open={Boolean(id)} onClose={onClose} size="lg"
        title={m ? `Membership ${m.number}` : 'Membership'}
        footer={<button className="btn btn-secondary" type="button" onClick={onClose}>Close</button>}>
        {!m ? <p className="muted">Loading…</p> : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <StatusBadge tone={MEMBERSHIP_STATUS_TONE[m.status] || 'muted'}
                label={MEMBERSHIP_STATUS_LABELS[m.status] || m.status} />
              <span className="muted" style={{ fontSize: 13 }}>
                {m.customer_name} · {m.plan_name} · {new Date(m.start_date).toLocaleDateString()} - {new Date(m.end_date).toLocaleDateString()}
              </span>
            </div>

            {/* Lifecycle actions */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={async () => {
                try {
                  const blob = await membershipsApi.download(m.id);
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a'); a.href = url; a.download = `${m.number}.pdf`; a.click();
                  URL.revokeObjectURL(url);
                } catch (e) { toast.error(apiErrorMessage(e, 'Unable to download the card.')); }
              }}>Download card</button>
              {canEdit && (() => {
                // Warn harder when the membership is still active well before
                // expiry - renewing now charges another full term immediately.
                const daysLeft = m.status === 'active' && m.end_date
                  ? Math.ceil((new Date(m.end_date) - new Date()) / 86400000) : 0;
                const isEarly = daysLeft > 30;
                return (
                  <button className="btn btn-secondary btn-sm" disabled={busy}
                    onClick={() => ask({
                      title: isEarly ? 'Renew early?' : 'Renew membership?',
                      tone: 'warning', confirmLabel: 'Renew & charge',
                      message: isEarly
                        ? `${m.number} is still active for ${daysLeft} more days (until ${new Date(m.end_date).toLocaleDateString()}). Renewing now charges the plan price again immediately and extends the term. Continue?`
                        : `This charges the plan price to the customer and raises a new invoice + receipt for ${m.number}. Continue?`,
                    }, () => act(() => membershipsApi.renew(m.id, 'card', { confirmEarly: true }), 'Membership renewed'))}>
                    <RefreshCw size={14} /> Renew</button>
                );
              })()}
              {canSuspend && m.status === 'active' && <button className="btn btn-secondary btn-sm" disabled={busy}
                onClick={() => ask({
                  title: 'Suspend membership?', tone: 'warning', confirmLabel: 'Suspend',
                  message: 'The customer keeps the membership but cannot use its benefits until it is resumed.',
                }, () => act(() => membershipsApi.suspend(m.id, ''), 'Membership suspended'))}>Suspend</button>}
              {canSuspend && m.status === 'suspended' && <button className="btn btn-secondary btn-sm" disabled={busy}
                onClick={() => ask({
                  title: 'Resume membership?', confirmLabel: 'Resume',
                  message: 'Re-activate this membership so its benefits apply again.',
                }, () => act(() => membershipsApi.resume(m.id), 'Membership resumed'))}>Resume</button>}
              {canEdit && (
                <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <input className="form-input" style={{ width: 64 }} type="number" min="1" value={extendDays}
                    onChange={(e) => setExtendDays(e.target.value)} />
                  <button className="btn btn-secondary btn-sm" disabled={busy}
                    onClick={() => {
                      const days = Number(extendDays);
                      if (!days || days < 1) { toast.error('Enter a number of days greater than zero.'); return; }
                      ask({
                        title: 'Extend membership?', confirmLabel: `Extend ${days} day(s)`,
                        message: `Push the end date out by ${days} day(s) for ${m.number}?`,
                      }, () => act(() => membershipsApi.extend(m.id, { days }), 'Membership extended'));
                    }}>Extend days</button>
                </span>
              )}
              {canCancel && m.status !== 'cancelled' && <button className="btn btn-ghost btn-sm" disabled={busy}
                style={{ color: 'var(--color-danger,#dc2626)' }} onClick={() => { setCancelReason(''); setCancelOpen(true); }}>Cancel</button>}
            </div>

            {/* Entitlements + balances */}
            <h4 style={{ margin: '8px 0 6px', fontSize: 13.5 }}>Entitlements</h4>
            {(m.entitlements || []).length === 0 ? <p className="muted" style={{ fontSize: 13 }}>No entitlements.</p> : (
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', marginBottom: 12 }}>
                <tbody>
                  {m.entitlements.map((e) => {
                    const st = statusFor(e.id);
                    const consumed = st.consumed || 0;
                    const cap = e.limit_type === 'unlimited'
                      ? 'Unlimited'
                      : `${st.remaining ?? Math.max(0, e.quantity || 0)} left of ${e.quantity}`
                        + (st.granted ? ` (+${st.granted} bonus)` : '')
                        + (st.reserved ? ` · ${st.reserved} held` : '');
                    return (
                      <tr key={e.id} style={{ borderTop: '1px solid var(--color-border,#e5e7eb)' }}>
                        <td style={{ padding: '6px 8px' }}>{entLabel(e)} <span className="muted">({e.period})</span></td>
                        <td style={{ padding: '6px 8px', textAlign: 'right' }}>{cap}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {canAdjust && e.limit_type === 'limited' && consumed > 0 && (
                            <button className="btn btn-ghost btn-sm" disabled={busy}
                              onClick={() => ask({
                                title: 'Restore one used unit?', confirmLabel: 'Restore 1',
                                message: `Return 1 consumed unit of "${entLabel(e)}" to the balance.`,
                              }, () => act(() => membershipsApi.adjustUsage(m.id, { entitlement: e.id, units: 1, note: 'Manual restore' }), 'Usage restored'))}>
                              Restore 1</button>
                          )}
                          {canAdjust && e.limit_type === 'limited' && (
                            <button className="btn btn-ghost btn-sm" disabled={busy}
                              onClick={() => ask({
                                title: 'Grant a bonus unit?', tone: 'warning', confirmLabel: 'Grant 1',
                                message: `Add 1 extra unit of "${entLabel(e)}" beyond the plan quantity (a free bonus).`,
                              }, () => act(() => membershipsApi.adjustUsage(m.id, { entitlement: e.id, units: 1, grant: true, note: 'Bonus grant' }), 'Bonus unit granted'))}>
                              Grant 1</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {/* Usage history */}
            <h4 style={{ margin: '8px 0 6px', fontSize: 13.5 }}>Usage history</h4>
            {usage.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>No usage yet.</p> : (
              <div style={{ maxHeight: 160, overflow: 'auto', marginBottom: 12 }}>
                {usage.map((u) => (
                  <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '3px 0' }}>
                    <span>{u.txn_type} {u.quantity} {u.target_label ? `- ${u.target_label}` : ''} {u.booking_reference ? `(${u.booking_reference})` : ''}</span>
                    <span className="muted">{new Date(u.created_at).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Financial history */}
            <h4 style={{ margin: '8px 0 6px', fontSize: 13.5 }}>Financial history</h4>
            {(m.invoices || []).length === 0 ? <p className="muted" style={{ fontSize: 13 }}>No invoices.</p> : (
              <div>
                {m.invoices.map((inv) => (
                  <div key={inv.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
                    <span>
                      {inv.number}
                      {inv.purpose_display && inv.purpose !== 'sale' && (
                        <span className="muted"> · {inv.purpose_display}</span>)}
                      {' '}<span className="muted">({inv.status_display})</span>
                    </span>
                    <Money amount={inv.total} code={inv.currency} />
                  </div>
                ))}
              </div>
            )}

            {/* Activity timeline - lifecycle + major changes (from the audit trail) */}
            <h4 style={{ margin: '12px 0 6px', fontSize: 13.5 }}>Activity timeline</h4>
            <ActivityTimeline rows={activity} />
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirm} busy={busy} tone={confirm?.tone || 'default'}
        title={confirm?.title} message={confirm?.message}
        confirmLabel={confirm?.confirmLabel || 'Confirm'}
        onConfirm={() => { const c = confirm; setConfirm(null); c?.run?.(); }}
        onClose={() => { if (!busy) setConfirm(null); }}
      />

      <ConfirmDialog
        open={cancelOpen} busy={busy} tone="danger" title="Cancel membership?" confirmLabel="Cancel membership"
        message={(
          <>
            Cancel this membership? Future coverage stops. Refund the fee separately via its invoice if needed.
            <input className="form-input" style={{ marginTop: 10 }} placeholder="Reason (optional)"
              value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
          </>
        )}
        onConfirm={() => { setCancelOpen(false); act(() => membershipsApi.cancel(m.id, cancelReason), 'Membership cancelled'); }}
        onClose={() => { if (!busy) setCancelOpen(false); }}
      />
    </>
  );
}

function IssueMembershipModal({ open, onClose, onDone }) {
  const [customers, setCustomers] = useState([]);
  const [plans, setPlans] = useState([]);
  const [customerId, setCustomerId] = useState('');
  const [planId, setPlanId] = useState('');
  const [method, setMethod] = useState('card');
  const [promo, setPromo] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCustomerId(''); setPlanId(''); setMethod('card'); setPromo('');
    customersApi.list({ page_size: 100 }).then((d) => setCustomers(d.results || d));
    membershipPlansApi.list({ is_active: 'true', page_size: 100 }).then((d) => setPlans(d.results || d));
  }, [open]);

  async function submit() {
    if (!customerId || !planId) return;
    setBusy(true);
    try {
      await membershipsApi.issue(Number(customerId), Number(planId),
        { method, promo: promo.trim() || undefined });
      onDone?.();
    } catch (e) { toast.error(apiErrorMessage(e, 'Unable to issue the membership. Please try again.')); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Issue membership" size="sm"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={!customerId || !planId || busy}>Issue</button>
      </>}>
      <FormField label="Customer">
        <Select2
          options={customers.map((c) => ({ value: c.id, label: `${c.full_name} (${c.email})` }))}
          value={customerId} onChange={setCustomerId} placeholder="Choose a customer…"
        />
      </FormField>
      <FormField label="Plan">
        <Select2
          options={plans.map((p) => ({ value: p.id, label: `${p.name} - ${fmtMoney(p.price)}` }))}
          value={planId} onChange={setPlanId} placeholder="Choose a plan…"
        />
      </FormField>
      <FormField label="Payment method" hint="Charges the plan price and raises an invoice + receipt.">
        <Select2 options={MEMBERSHIP_PAYMENT_METHODS} value={method} onChange={setMethod} />
      </FormField>
      <FormField label="Promo code (optional)" hint="Applies a discount to the plan price.">
        <input className="form-input" value={promo} onChange={(e) => setPromo(e.target.value)} placeholder="e.g. SAVE10" />
      </FormField>
    </Modal>
  );
}

/* ------------------------------ Plans tab ------------------------------ */
function PlansTab() {
  const { hasPerm } = useAuth();
  const [editing, setEditing] = useState(null);   // plan object, or {} for new
  const fetcher = useCallback((q) => membershipPlansApi.list(q), []);
  const { rows, loading, reload } = useApiList(fetcher);
  const canEdit = hasPerm('subscriptions.add') || hasPerm('subscriptions.edit');

  return (
    <>
      {hasPerm('subscriptions.add') && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button className="btn btn-primary" onClick={() => setEditing({})}><Plus size={15} /> New plan</button>
        </div>
      )}
      <DataTable
        loading={loading}
        rows={rows}
        onRowClick={canEdit ? (r) => setEditing(r) : undefined}
        emptyTitle="No plans yet"
        emptyHint="Create a plan with service / add-on entitlements."
        columns={[
          { key: 'code', header: 'Code', render: (r) => r.code || '-' },
          { key: 'name', header: 'Plan', render: (r) => <span style={{ fontWeight: 600 }}>{r.name}</span> },
          { key: 'interval', header: 'Validity', render: (r) => intervalLabel(r.interval) },
          { key: 'price', header: 'Price', render: (r) => <Money amount={r.price} /> },
          { key: 'ents', header: 'Entitlements', render: (r) => (r.entitlements?.length ?? 0) },
          { key: 'group', header: 'Type', render: (r) => <StatusBadge tone={r.is_group ? 'info' : 'muted'} label={r.is_group ? 'Group' : 'Personal'} /> },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge tone={r.is_active ? 'success' : 'muted'} label={r.is_active ? 'Active' : 'Inactive'} /> },
        ]}
      />
      <PlanFormModal open={Boolean(editing)} plan={editing} onClose={() => setEditing(null)}
        onDone={() => { setEditing(null); reload(); }} />
    </>
  );
}

const BLANK_ENT = { target_type: 'facility_type', target: '', limit_type: 'limited', quantity: '', period: 'monthly' };

function planToForm(plan) {
  const p = plan || {};
  return {
    name: p.name || '', code: p.code || '', description: p.description || '',
    interval: p.interval || 'monthly', validity_mode: p.validity_mode || 'rolling',
    duration_days: p.duration_days ?? '', fixed_start: p.fixed_start || '', fixed_end: p.fixed_end || '',
    price: p.price ?? '', is_group: !!p.is_group, is_active: p.is_active ?? true,
    available_clubs: p.available_clubs || [],
    entitlements: (p.entitlements || []).map((e) => ({
      target_type: e.target_type,
      target: e.facility_type || e.service || e.addon || '',
      limit_type: e.limit_type, quantity: e.quantity ?? '', period: e.period,
    })),
  };
}

function PlanFormModal({ open, plan, onClose, onDone }) {
  const isEdit = Boolean(plan && plan.id);
  const [form, setForm] = useState(planToForm(plan));
  const [items, setItems] = useState([]);
  const [cats, setCats] = useState([]);
  const [addons, setAddons] = useState([]);
  const [clubs, setSites] = useState([]);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState(null);   // live included-value breakdown
  const [activity, setActivity] = useState(null);   // plan change timeline (edit)
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!open) return;
    setForm(planToForm(plan));
    facilityTypesApi.list({ page_size: 200 }).then((d) => setItems(d.results || d)).catch(() => {});
    facilityCategoriesApi.list({ page_size: 200 }).then((d) => setCats(d.results || d)).catch(() => {});
    addonsApi.list({ page_size: 200 }).then((d) => setAddons(d.results || d)).catch(() => {});
    clubsApi.list({ page_size: 200 }).then((d) => setSites(d.results || d)).catch(() => {});
    if (plan && plan.id) {
      setActivity(null);
      membershipPlansApi.activity(plan.id, { page_size: 50 })
        .then((d) => setActivity(d.results || d)).catch(() => setActivity([]));
    } else {
      setActivity(null);
    }
  }, [open, plan]);

  // Live included-value / savings - the backend is the single source of truth, so
  // re-price the draft (debounced) whenever the price or entitlements change.
  useEffect(() => {
    if (!open) { setValue(null); return undefined; }
    const ents = form.entitlements.filter((e) => e.target).map((e) => ({
      target_type: e.target_type,
      facility_type: e.target_type === 'facility_type' ? e.target : null,
      service: e.target_type === 'category' ? e.target : null,
      addon: e.target_type === 'addon' ? e.target : null,
      limit_type: e.limit_type,
      quantity: e.limit_type === 'limited' ? Number(e.quantity) || 0 : null,
      period: e.period,
    }));
    if (ents.length === 0 || form.price === '') { setValue(null); return undefined; }
    const t = setTimeout(() => {
      membershipPlansApi.valuePreview({ price: form.price, entitlements: ents })
        .then(setValue).catch(() => setValue(null));
    }, 350);
    return () => clearTimeout(t);
  }, [open, form.price, JSON.stringify(form.entitlements)]);

  const targetOptions = (t) => (
    t === 'category' ? cats : t === 'addon' ? addons : items
  ).map((o) => ({ value: o.id, label: o.name }));

  function setEnt(i, key, value) {
    setForm((f) => {
      const ents = f.entitlements.map((e, idx) => {
        if (idx !== i) return e;
        const next = { ...e, [key]: value };
        if (key === 'target_type') next.target = '';   // reset target when type changes
        return next;
      });
      return { ...f, entitlements: ents };
    });
  }
  const addEnt = () => setForm((f) => ({ ...f, entitlements: [...f.entitlements, { ...BLANK_ENT }] }));
  const removeEnt = (i) => setForm((f) => ({ ...f, entitlements: f.entitlements.filter((_, idx) => idx !== i) }));

  async function submit() {
    if (!form.name || !form.code || form.price === '') {
      toast.error('Name, code and price are required.'); return;
    }
    for (const e of form.entitlements) {
      if (!e.target) { toast.error('Each entitlement needs a target.'); return; }
      if (e.limit_type === 'limited' && !e.quantity) { toast.error('A limited entitlement needs a count.'); return; }
    }
    const payload = {
      name: form.name, code: form.code, description: form.description,
      interval: form.interval, validity_mode: form.validity_mode,
      duration_days: form.interval === 'custom' && form.duration_days !== '' ? Number(form.duration_days) : null,
      fixed_start: form.validity_mode === 'fixed' ? (form.fixed_start || null) : null,
      fixed_end: form.validity_mode === 'fixed' ? (form.fixed_end || null) : null,
      price: form.price, is_group: form.is_group, is_active: form.is_active,
      available_clubs: form.available_clubs,
      entitlements: form.entitlements.map((e) => ({
        target_type: e.target_type,
        facility_type: e.target_type === 'facility_type' ? e.target : null,
        service: e.target_type === 'category' ? e.target : null,
        addon: e.target_type === 'addon' ? e.target : null,
        limit_type: e.limit_type,
        quantity: e.limit_type === 'limited' ? Number(e.quantity) : null,
        period: e.period,
      })),
    };
    setBusy(true);
    try {
      if (isEdit) await membershipPlansApi.update(plan.id, payload);
      else await membershipPlansApi.create(payload);
      toast.success(isEdit ? 'Plan updated' : 'Plan created');
      onDone?.();
    } catch (e) { toast.error(apiErrorMessage(e, 'Unable to save the plan. Please try again.')); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit membership plan' : 'New membership plan'} size="lg"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>Save plan</button>
      </>}>
      <div className="row">
        <div className="col"><FormField label="Name">
          <input className="form-input" value={form.name} onChange={(e) => set('name')(e.target.value)} />
        </FormField></div>
        <div className="col"><FormField label="Plan code">
          <input className="form-input" value={form.code} onChange={(e) => set('code')(e.target.value)} placeholder="GOLD-M" />
        </FormField></div>
      </div>
      <div className="row">
        <div className="col"><FormField label="Validity">
          <Select2 options={MEMBERSHIP_INTERVALS} value={form.interval} onChange={set('interval')} />
        </FormField></div>
        <div className="col"><FormField label="Price">
          <input className="form-input" type="number" min="0" step="0.01" value={form.price}
                 onChange={(e) => set('price')(e.target.value)} />
        </FormField></div>
      </div>
      <div className="row">
        <div className="col"><FormField label="Validity mode">
          <Select2 options={VALIDITY_MODES} value={form.validity_mode} onChange={set('validity_mode')} />
        </FormField></div>
        {form.interval === 'custom' && (
          <div className="col"><FormField label="Duration (days)">
            <input className="form-input" type="number" min="1" value={form.duration_days}
                   onChange={(e) => set('duration_days')(e.target.value)} />
          </FormField></div>
        )}
      </div>
      {form.validity_mode === 'fixed' && (
        <div className="row">
          <div className="col"><FormField label="Fixed start">
            <input className="form-input" type="date" value={form.fixed_start} onChange={(e) => set('fixed_start')(e.target.value)} />
          </FormField></div>
          <div className="col"><FormField label="Fixed end">
            <input className="form-input" type="date" value={form.fixed_end} onChange={(e) => set('fixed_end')(e.target.value)} />
          </FormField></div>
        </div>
      )}
      <FormField label="Club availability" hint="Leave empty for all clubs.">
        <Select2 multiple options={clubs.map((s) => ({ value: s.id, label: s.name }))}
                 value={form.available_clubs} onChange={set('available_clubs')} placeholder="All clubs" />
      </FormField>
      <div className="row">
        <div className="col"><FormField label="Group plan">
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <input type="checkbox" checked={form.is_group} onChange={(e) => set('is_group')(e.target.checked)} />
            <span className="muted" style={{ fontSize: 13 }}>Shared by a family or group</span>
          </label>
        </FormField></div>
        <div className="col"><FormField label="Active">
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <input type="checkbox" checked={form.is_active} onChange={(e) => set('is_active')(e.target.checked)} />
            <span className="muted" style={{ fontSize: 13 }}>Plan is active</span>
          </label>
        </FormField></div>
      </div>

      {/* Entitlements editor */}
      <div style={{ marginTop: 12, borderTop: '1px solid var(--color-border)', paddingTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
          <strong style={{ fontSize: 13.5 }}>Entitlements</strong>
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={addEnt}>
            <Plus size={14} /> Add entitlement
          </button>
        </div>
        {form.entitlements.length === 0 && (
          <p className="muted" style={{ fontSize: 13 }}>No entitlements - add what this plan covers.</p>
        )}
        {form.entitlements.map((e, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.4fr 1fr 0.7fr 1fr auto', gap: 8, marginBottom: 8, alignItems: 'center' }}>
            <Select2 options={ENTITLEMENT_TARGETS} value={e.target_type} onChange={(v) => setEnt(i, 'target_type', v)} />
            <Select2 options={targetOptions(e.target_type)} value={e.target} onChange={(v) => setEnt(i, 'target', v)} placeholder="Select…" />
            <Select2 options={ENTITLEMENT_LIMITS} value={e.limit_type} onChange={(v) => setEnt(i, 'limit_type', v)} />
            <input className="form-input" type="number" min="1" placeholder="Qty"
              value={e.limit_type === 'limited' ? e.quantity : ''} disabled={e.limit_type !== 'limited'}
              onChange={(ev) => setEnt(i, 'quantity', ev.target.value)} />
            <Select2 options={ENTITLEMENT_PERIODS} value={e.period} onChange={(v) => setEnt(i, 'period', v)} />
            <button className="icon-btn" title="Remove" onClick={() => removeEnt(i)}><Trash2 size={15} /></button>
          </div>
        ))}
      </div>

      <PlanValuePanel value={value} />

      {isEdit && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--color-border)', paddingTop: 12 }}>
          <strong style={{ fontSize: 13.5 }}>Change timeline</strong>
          <div style={{ marginTop: 6 }}><ActivityTimeline rows={activity} /></div>
        </div>
      )}
    </Modal>
  );
}

function PlanValuePanel({ value }) {
  if (!value) return null;
  const save = Number(value.savings);
  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--color-border)', paddingTop: 12 }}>
      <strong style={{ fontSize: 13.5 }}>Included value &amp; savings</strong>
      <p className="muted" style={{ fontSize: 12, margin: '2px 0 8px' }}>
        Value of the included facilities / add-ons at standard list price, vs the plan price.
        Informational - excludes promotions and booking pricing rules.
      </p>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: 8,
        alignItems: 'center', fontSize: 13, padding: '6px 10px',
        background: 'var(--color-surface-2, #f7f8fa)', borderRadius: 8,
      }}>
        <span>Value: <Money amount={value.included_value} code={value.currency} /></span>
        <span style={{ color: save > 0 ? 'var(--color-success, #10b981)' : 'var(--color-text-muted)', fontWeight: 600 }}>
          {save > 0
            ? <>Save <Money amount={value.savings} code={value.currency} />{value.savings_pct != null ? ` (${value.savings_pct}%)` : ''}</>
            : (save < 0 ? <>Over by <Money amount={String(Math.abs(save))} code={value.currency} /></> : 'Matches price')}
        </span>
      </div>
      {(value.unlimited || []).length > 0 && (
        <p style={{ fontSize: 12.5, marginTop: 8 }}>
          <strong>+ Unlimited:</strong>{' '}
          {value.unlimited.map((u) => u.label).filter(Boolean).join(', ')}
          <span className="muted"> (value not counted above)</span>
        </p>
      )}
    </div>
  );
}
