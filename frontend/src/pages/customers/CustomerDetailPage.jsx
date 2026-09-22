import { useCallback, useEffect, useState } from 'react';
import { formatDate } from '../../services/timeformat.jsx';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Mail, Phone, MapPin, Award, FileText, RefreshCw, History, AlertTriangle, GitMerge, ShieldCheck, ShieldAlert, Trash2, Calendar, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { formatTime } from '../../services/timeformat.jsx';

import { PageHeader } from '../../components/PageHeader.jsx';
import { Modal } from '../../components/Modal.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { customersApi } from '../../services/customersService.js';
import { bookingsApi } from '../../services/bookingsService.js';
import { loyaltyApi } from '../../services/loyaltyService.js';
import { invoicesApi, INVOICE_STATUS_TONE } from '../../services/paymentsService.js';
import {
  membershipsApi, MEMBERSHIP_STATUS_TONE, membershipStatusLabels,
} from '../../services/subscriptionsService.js';
import { Money } from '../../services/currency.jsx';
import { usePrompt } from '../../components/PromptDialog.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { apiErrorMessage } from '../../utils/apiError';

const LOGIN_TONE = {
  'Login Enabled': 'success', 'Login Disabled': 'danger',
  'Invite Pending': 'warning', 'No Login': 'muted',
};

export default function CustomerDetailPage() {
  const { t } = useTranslation('customers');
  const { id } = useParams();
  const navigate = useNavigate();
  const prompt = usePrompt();
  const { hasPerm } = useAuth();
  const canManage = hasPerm('customers.edit');
  // Merging is a dedicated, sensitive capability of its own (not Edit/Delete).
  const canMerge = hasPerm('customers.merge');
  const canVerify = hasPerm('customers.verify');
  const canDelete = hasPerm('customers.delete');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loyaltyReload, setLoyaltyReload] = useState(0);
  const [customer, setCustomer] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [memberships, setMemberships] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [duplicates, setDuplicates] = useState([]);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [bookings, setBookings] = useState([]);
  const [bookingsOpen, setBookingsOpen] = useState(false);

  async function loginAction(fn, okMsg) {
    setBusy(true);
    try { setCustomer(await fn()); toast.success(okMsg); }
    catch (e) { toast.error(apiErrorMessage(e, t('unableUpdateLoginAccessPlease'))); }
    finally { setBusy(false); }
  }

  async function doVerify() {
    setBusy(true);
    try {
      setCustomer(await customersApi.verify(id));
      toast.success(t('customerVerified'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableVerifyCustomerPleaseTry')));
    } finally { setBusy(false); }
  }

  async function adjustLoyalty() {
    const points = Number(await prompt({ title: t('adjustLoyalty'), label: t('pointsAdjustNegativeDeduct'), type: 'number' }));
    if (!points) return;
    const note = (await prompt({ title: t('adjustLoyalty'), label: t('noteAdjustment') })) || '';
    try {
      const updated = await customersApi.adjustLoyalty(id, { points, note });
      setCustomer(updated);
      setLoyaltyReload((n) => n + 1);
      toast.success(t('loyaltyPointsUpdated'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableAdjustLoyaltyPoints')));
    }
  }

  async function doDelete() {
    setBusy(true);
    try {
      await customersApi.remove(id);
      toast.success(t('customerDeleted'));
      navigate('/customers');
    } catch (e) {
      setConfirmDelete(false);
      toast.error(apiErrorMessage(e, t('unableDeleteCustomerPleaseTry')));
    } finally { setBusy(false); }
  }

  const load = useCallback(() => {
    setLoading(true);
    customersApi.get(id)
      .then((c) => setCustomer(c))
      .catch((e) => toast.error(apiErrorMessage(e, t('unableLoadCustomerPleaseTry'))))
      .finally(() => setLoading(false));
  }, [id, t]);

  useEffect(load, [load]);

  const loadDuplicates = useCallback(() => {
    customersApi.duplicates(id)
      .then((d) => setDuplicates(d || []))
      .catch(() => setDuplicates([]));
  }, [id]);

  useEffect(loadDuplicates, [loadDuplicates]);

  useEffect(() => {
    if (!hasPerm('invoicing.view')) return;
    invoicesApi.list({ customer: id })
      .then((d) => setInvoices(d.results || d)).catch(() => {});
  }, [id, hasPerm]);

  useEffect(() => {
    if (!hasPerm('subscriptions.view')) return;
    membershipsApi.list({ customer: id })
      .then((d) => setMemberships(d.results || d)).catch(() => {});
  }, [id, hasPerm]);

  useEffect(() => {
    if (!hasPerm('bookings.view')) return;
    bookingsApi.list({ customer: id, ordering: '-scheduled_date', page_size: 100 })
      .then((d) => setBookings(d.results || d)).catch(() => {});
  }, [id, hasPerm]);

  async function downloadInvoice(inv) {
    try {
      const blob = await invoicesApi.download(inv.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${inv.number}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast.error(apiErrorMessage(e, t('unableDownloadInvoicePleaseTry'))); }
  }

  if (loading) {
    return <div className="card"><div className="card-body center" style={{ padding: 64 }}><span className="muted">Loading customer…</span></div></div>;
  }
  if (!customer) return null;

  return (
    <>
      <button
        className="btn btn-ghost"
        onClick={() => navigate('/customers')}
        style={{ marginBottom: 12 }}
      >
        <ArrowLeft size={15} /> {t('backCustomers')}
      </button>

      <PageHeader
        title={customer.full_name}
        subtitle={`${customer.customer_code ? `${customer.customer_code} · ` : ''}Customer since ${formatDate(customer.member_since)}`}
        actions={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!customer.is_verified && canVerify && (
              <button className="btn btn-primary" disabled={busy} onClick={doVerify}>
                <ShieldCheck size={15} /> {t('verifyCustomer')}
              </button>
            )}
            {/* Only UNVERIFIED customers can be deleted (junk/fake cleanup). */}
            {!customer.is_verified && canDelete && (
              <button className="btn btn-ghost" disabled={busy}
                style={{ color: 'var(--color-danger, #dc2626)' }}
                onClick={() => setConfirmDelete(true)}>
                <Trash2 size={15} /> {t('common:actions.delete')}
              </button>
            )}
          </div>
        }
      />

      {hasPerm('bookings.view') && (
        <div style={{ marginBottom: 16 }}>
          <button
            type="button"
            onClick={() => setBookingsOpen((o) => !o)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer',
              padding: '8px 14px', borderRadius: 10, background: 'var(--color-surface, #fff)',
              border: '1px solid var(--color-border-soft, #e5e7eb)', fontWeight: 600,
            }}
          >
            {bookingsOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            <Calendar size={15} style={{ color: 'var(--color-text-muted)' }} />
            {t('bookings')}
            <span className="badge" style={{
              background: 'var(--color-primary-bg, #eff6ff)', color: 'var(--color-primary, #2563eb)',
              borderRadius: 999, padding: '1px 9px', fontSize: 12.5, fontWeight: 700,
            }}>{bookings.length}</span>
          </button>

          {bookingsOpen && (
            <div className="card" style={{ marginTop: 8 }}>
              {bookings.length === 0 ? (
                <div className="empty"><p>{t('noBookingsCustomer')}</p></div>
              ) : (
                <div className="table-wrapper">
                  <table className="table">
                    <thead><tr><th>{t('reference')}</th><th>{t('service')}</th><th>{t('scheduled')}</th><th>{t('common:labels.status')}</th><th>{t('common:labels.total')}</th></tr></thead>
                    <tbody>
                      {bookings.map((b) => (
                        <tr key={b.id} style={{ cursor: 'pointer' }}
                          onClick={() => navigate(`/bookings/${b.id}`)}>
                          <td style={{ fontWeight: 600 }}>
                            {b.reference}
                            {/* Several slots bought in one checkout are several
                                bookings. Naming the order here is what stops a
                                customer's history reading as unrelated visits. */}
                            {b.order_reference && (
                              <div className="muted" style={{ fontSize: 11.5, fontWeight: 500 }}>
                                {b.order_reference}
                              </div>
                            )}
                          </td>
                          <td>{b.facility_type_name || b.facility_category_name || '-'}</td>
                          <td>
                            {formatDate(b.scheduled_date)}
                            <span className="muted" style={{ fontSize: 12 }}> · {formatTime(b.scheduled_time)}</span>
                          </td>
                          <td><StatusBadge status={b.status} /></td>
                          <td><Money amount={b.total_amount} code={b.currency} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {duplicates.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          padding: '12px 16px', borderRadius: 10, marginBottom: 16, flexWrap: 'wrap',
          background: 'var(--color-warning-bg, #fff7ed)', border: '1px solid var(--color-warning, #f59e0b)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <AlertTriangle size={20} style={{ color: 'var(--color-warning, #b45309)', flexShrink: 0 }} />
            <div style={{ fontSize: 13.5 }}>
              <strong>{duplicates.length} possible duplicate record{duplicates.length > 1 ? 's' : ''}</strong>{' '}
              share this customer’s {Array.from(new Set(duplicates.map((d) => d.match))).join(' / ')}.
              Merge them so all bookings, payments and balances live on one record.
            </div>
          </div>
          {canMerge && (
            <button className="btn btn-primary btn-sm" onClick={() => setMergeOpen(true)}>
              <GitMerge size={15} /> {t('reviewAndMerge')}
            </button>
          )}
        </div>
      )}

      <div className="row">
        <div className="col" style={{ flex: '1 1 320px' }}>
          <div className="card">
            <div className="card-header">
              <div>
                <h3 className="card-title">{t('profile')}</h3>
                <p className="card-subtitle">{t('contactAccountLevelInformation')}</p>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {customer.is_verified
                  ? <StatusBadge tone="success" label={t('verified')} />
                  : <StatusBadge tone="warning" label={t('unverified')} />}
                <StatusBadge
                  tone={customer.is_corporate ? 'info' : 'muted'}
                  label={customer.is_corporate ? t('corporate') : t('individual')}
                />
              </div>
            </div>
            <div className="card-body">
              <KV label={t('customerNumber')}>{customer.customer_code || '-'}</KV>
              <KV icon={customer.is_verified ? ShieldCheck : ShieldAlert} label={t('verification')}>
                {customer.is_verified ? (
                  <span>
                    Verified{customer.verification_method_display ? ` · ${customer.verification_method_display}` : ''}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {customer.verified_at ? formatDate(customer.verified_at) : ''}
                      {customer.verified_by_name ? ` · by ${customer.verified_by_name}` : ''}
                    </div>
                  </span>
                ) : (
                  <span className="muted">Not verified yet
                    {canVerify ? ' - use “Verify customer” above, or it verifies automatically when a booking is confirmed.' : ''}
                  </span>
                )}
              </KV>
              <KV icon={Mail}  label={t('common:labels.email')}>{customer.email}</KV>
              <KV icon={Phone} label={t('common:labels.phone')}>{customer.phone || '-'}</KV>
              <div className="divider" />
              <KV label={t('loyaltyTier')}>
                <StatusBadge tone="warning" label={customer.loyalty_tier} />
              </KV>
              <KV label={t('loyaltyPoints')}>{customer.loyalty_points}</KV>
              <KV label={t('lifetimeValue')}><Money amount={customer.lifetime_value} /></KV>
              <KV label={t('sourceLabel')}>{customer.source.replace('_', ' ')}</KV>
              {customer.notes && (
                <>
                  <div className="divider" />
                  <div className="muted" style={{ fontSize: 12 }}>NOTES</div>
                  <div>{customer.notes}</div>
                </>
              )}
            </div>
          </div>

          <div style={{ height: 16 }} />

          {/* Login access - mobile-app login only; never grants admin access. */}
          <div className="card">
            <div className="card-header">
              <div>
                <h3 className="card-title">{t('loginAccess')}</h3>
                <p className="card-subtitle">{t('mobileAppLoginCustomer')}</p>
              </div>
              <StatusBadge tone={LOGIN_TONE[customer.login_status] || 'muted'} label={customer.login_status} />
            </div>
            <div className="card-body">
              {customer.linked_user ? (
                <KV icon={Mail} label={t('loginEmail')}>{customer.linked_user.email}</KV>
              ) : (
                <p className="muted" style={{ fontSize: 13 }}>
                  {t('customerHasNoLoginYet')}
                </p>
              )}
              {canManage && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                  {!customer.linked_user && (
                    <>
                      <button className="btn btn-secondary btn-sm" disabled={busy}
                        onClick={async () => {
                          const email = await prompt({ title: t('createLogin'),
                            label: t('loginEmailCustomerWebsite'), defaultValue: customer.email || '' });
                          if (!email) return;
                          loginAction(() => customersApi.createLogin(id, { email }), 'Login created');
                        }}>{t('createLogin')}</button>
                      {customer.login_status !== 'Invite Pending' && (
                        <button className="btn btn-ghost btn-sm" disabled={busy}
                          onClick={() => loginAction(() => customersApi.inviteLogin(id), 'Invite recorded')}>
                          {t('inviteCreateLogin')}
                        </button>
                      )}
                    </>
                  )}
                  {customer.login_status === 'Login Enabled' && (
                    <button className="btn btn-ghost btn-sm" disabled={busy} style={{ color: 'var(--color-danger,#dc2626)' }}
                      onClick={() => loginAction(() => customersApi.disableLogin(id), 'Login disabled')}>
                      {t('disableLogin')}
                    </button>
                  )}
                  {customer.login_status === 'Login Disabled' && (
                    <button className="btn btn-secondary btn-sm" disabled={busy}
                      onClick={() => loginAction(() => customersApi.enableLogin(id), 'Login enabled')}>
                      {t('enableLogin')}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="col" style={{ flex: '2 1 480px' }}>
          <div className="card">
            <div className="card-header">
              <div>
                <h3 className="card-title"><MapPin size={15} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />{t('savedAddresses')}</h3>
                <p className="card-subtitle">{t('contactAddressesFileCustomer')}</p>
              </div>
            </div>
            {(customer.addresses || []).length === 0 ? (
              <div className="empty"><p>{t('noSavedAddresses')}</p></div>
            ) : (
              <div className="card-body">
                {customer.addresses.map((a) => (
                  <div key={a.id} style={{
                    padding: '12px 14px',
                    border: '1px solid var(--color-border-soft)',
                    borderRadius: 10,
                    marginBottom: 10,
                    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                  }}>
                    <div>
                      <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{a.label}</div>
                      <div className="muted" style={{ fontSize: 12.5 }}>
                        {a.line1}{a.line2 && `, ${a.line2}`}, {a.city}
                      </div>
                    </div>
                    {a.is_default && <StatusBadge tone="success" label={t('default')} />}
                  </div>
                ))}
              </div>
            )}
          </div>

          {hasPerm('invoicing.view') && (
            <>
              <div style={{ height: 16 }} />
              <div className="card">
                <div className="card-header">
                  <div>
                    <h3 className="card-title"><FileText size={15} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />{t('invoices')}</h3>
                    <p className="card-subtitle">{t('vatInvoicesCustomer')}</p>
                  </div>
                </div>
                {invoices.length === 0 ? (
                  <div className="empty"><p>{t('noInvoicesYet')}</p></div>
                ) : (
                  <div className="table-wrapper">
                    <table className="table">
                      <thead><tr><th>{t('invoice')}</th><th>{t('common:labels.total')}</th><th>{t('common:labels.status')}</th><th>{t('issued')}</th><th></th></tr></thead>
                      <tbody>
                        {invoices.map((inv) => (
                          <tr key={inv.id}>
                            <td style={{ fontWeight: 600 }}>
                              {inv.number}
                              {inv.purpose && inv.purpose !== 'sale' && (
                                <div className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                                  {inv.purpose_display}{inv.membership_number ? ` · ${inv.membership_number}` : ''}
                                </div>
                              )}
                            </td>
                            <td><Money amount={inv.total} code={inv.currency} /></td>
                            <td><StatusBadge tone={INVOICE_STATUS_TONE[inv.status] || 'muted'}
                              label={inv.status_display || inv.status} /></td>
                            <td>{formatDate(inv.issued_at)}</td>
                            <td style={{ textAlign: 'right' }}>
                              <button className="icon-btn" title={t('downloadPdf')} onClick={() => downloadInvoice(inv)}>
                                <FileText size={15} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

          {hasPerm('subscriptions.view') && memberships.length > 0 && (
            <>
              <div style={{ height: 16 }} />
              <div className="card">
                <div className="card-header">
                  <div>
                    <h3 className="card-title"><RefreshCw size={15} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />{t('memberships')}</h3>
                    <p className="card-subtitle">{t('activePastMembershipsRemainingEntitlements')}</p>
                  </div>
                </div>
                <div style={{ padding: '4px 16px 12px' }}>
                  {memberships.map((m) => (
                    <div key={m.id} style={{ padding: '8px 0', borderTop: '1px solid var(--color-border,#e5e7eb)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 600 }}>{m.number}</span>
                        <span className="muted" style={{ fontSize: 13 }}>{m.plan_name}</span>
                        <StatusBadge tone={MEMBERSHIP_STATUS_TONE[m.status] || 'muted'}
                          label={membershipStatusLabels(t)[m.status] || m.status} />
                        <span className="muted" style={{ fontSize: 12.5, marginLeft: 'auto' }}>
                          {formatDate(m.start_date)} - {formatDate(m.end_date)}
                        </span>
                      </div>
                      <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                        {(m.entitlements || []).map((e) => {
                          // Current-period remaining from the backend (includes bonus grants).
                          const st = (m.entitlement_status || []).find((s) => s.entitlement === e.id) || {};
                          const label = e.facility_type_name || e.facility_category_name || e.addon_name || 'item';
                          const left = e.limit_type === 'unlimited'
                            ? 'unlimited'
                            : `${st.remaining ?? Math.max(0, e.quantity || 0)}/${e.quantity}`
                              + (st.granted ? ` (+${st.granted})` : '');
                          return `${label}: ${left}`;
                        }).join('  ·  ') || 'No entitlements'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {hasPerm('loyalty.view') && (
            <>
              <div style={{ height: 16 }} />
              <CustomerLoyalty customerId={id} reloadKey={loyaltyReload}
                canReverse={hasPerm('loyalty.reverse')}
                canAdjust={hasPerm('loyalty.adjust')} onAdjust={adjustLoyalty} />
            </>
          )}

          <div style={{ height: 16 }} />
          <CustomerActivity customerId={id} />
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        tone="danger"
        title={t('deleteCustomer')}
        message={`Permanently delete ${customer.full_name || customer.customer_code}? Only unverified customers can be deleted. This cannot be undone.`}
        confirmLabel={t('deleteCustomer')}
        busy={busy}
        onConfirm={doDelete}
        onClose={() => { if (!busy) setConfirmDelete(false); }}
      />

      <MergeModal
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        current={customer}
        duplicates={duplicates}
        onMerged={(survivorId) => {
          setMergeOpen(false);
          toast.success(t('recordsMerged'));
          if (String(survivorId) === String(id)) {
            load();
            loadDuplicates();
          } else {
            navigate(`/customers/${survivorId}`);
          }
        }}
      />
    </>
  );
}

function MergeModal({ open, onClose, current, duplicates, onMerged }) {
  const { t } = useTranslation('customers');
  const group = current ? [current, ...duplicates] : duplicates;
  // `survivorId` = the record to KEEP. `selected` = the duplicates to merge in
  // (checkboxes); unticked duplicates are left untouched as separate customers.
  const [survivorId, setSurvivorId] = useState(current?.id);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  // Default: keep the viewed record, pre-tick every duplicate so the common
  // "merge them all" case is one click - but each can be unticked.
  useEffect(() => {
    if (!open) return;
    setSurvivorId(current?.id);
    setSelected(new Set(duplicates.map((d) => d.id)));
  }, [open, current?.id, duplicates]);

  if (!current) return null;

  const fmt = (g) => g.full_name || g.name || g.email || g.phone || g.code || g.customer_code;
  const codeOf = (g) => g.code || g.customer_code || '';
  const sourceIds = [...selected].filter((sid) => String(sid) !== String(survivorId));

  function toggle(gid) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid); else next.add(gid);
      return next;
    });
  }

  function chooseKeep(gid) {
    // The kept record must be part of the merge, so ticking it as Keep includes it.
    setSurvivorId(gid);
    setSelected((prev) => new Set(prev).add(gid));
  }

  async function doMerge() {
    setBusy(true);
    try {
      await customersApi.merge(survivorId, sourceIds);
      onMerged?.(survivorId);
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableMergeTheseRecordsPlease')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('mergeDuplicateCustomers')}
      size="md"
      footer={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>{t('common:actions.cancel')}</button>
          <button className="btn btn-primary" type="button" onClick={doMerge} disabled={busy || sourceIds.length === 0}>
            {busy ? 'Merging…' : `Merge ${sourceIds.length} record${sourceIds.length === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      <p style={{ fontSize: 13.5, marginTop: 0 }}>
        <strong>{t('tickRecordsMerge')}</strong>, and choose the one to <strong>keep</strong>.
        Every booking, payment, invoice, membership, wallet balance, loyalty point and
        activity-log entry from the ticked records is moved onto the kept record; its blank fields
        are filled in from the others (existing values are never overwritten). The ticked records
        are then deleted. Untick any record to leave it as a separate customer. This cannot be undone.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {group.map((g) => {
          const keep = String(g.id) === String(survivorId);
          const included = keep || selected.has(g.id);
          const border = keep ? 'var(--color-primary, #2563eb)'
            : included ? 'var(--color-warning, #f59e0b)' : 'var(--color-border-soft, #e5e7eb)';
          return (
            <div key={g.id} style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '10px 12px', borderRadius: 10,
              border: `1px solid ${border}`,
              background: keep ? 'var(--color-primary-bg, #eff6ff)' : 'transparent',
              opacity: included ? 1 : 0.6,
            }}>
              <input type="checkbox" checked={included} disabled={keep} style={{ marginTop: 3 }}
                title={keep ? t('keptRecordAlwaysPartMerge') : t('includeMerge')}
                onChange={() => toggle(g.id)} />
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600 }}>{fmt(g)}</span>
                  <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{codeOf(g)}</span>
                  {keep
                    ? <StatusBadge tone="success" label={t('keep')} />
                    : included
                      ? <StatusBadge tone="danger" label={t('mergeDelete')} />
                      : <StatusBadge tone="muted" label={t('leaveSeparate')} />}
                  {!keep && (
                    <button type="button" className="link-btn" style={{ fontSize: 12 }}
                      onClick={() => chooseKeep(g.id)}>{t('setAsKeep')}</button>
                  )}
                </div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {g.email || '-'}{g.phone ? ` · ${g.phone}` : ''}
                  {typeof g.bookings === 'number' ? ` · ${g.bookings} booking${g.bookings === 1 ? '' : 's'}` : ''}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

const ACTIVITY_LABELS = {
  customer_verified: 'Customer verified',
  customer_merged: 'Duplicate records merged',
  booking_deleted: 'Booking deleted',
  customer_updated: 'Customer details updated',
  customer_login_created: 'Login created',
  customer_login_invited: 'Login invite sent',
  customer_login_linked: 'Login linked',
  customer_login_disabled: 'Login disabled',
  customer_login_enabled: 'Login enabled',
};

const LEDGER_TONE = {
  earn: 'success', bonus: 'success', adjust: 'info', redeem: 'warning',
  expire: 'muted', reversed: 'danger', merged: 'info', correction: 'info',
};

function CustomerLoyalty({ customerId, reloadKey, canReverse, canAdjust, onAdjust }) {
  const { t } = useTranslation('customers');
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState(null);

  const load = useCallback(() => {
    loyaltyApi.summary(customerId).then(setSummary).catch(() => setSummary(null));
    loyaltyApi.ledger({ customer: customerId, ordering: '-created_at' })
      .then((d) => setRows(d.results || d || [])).catch(() => setRows([]));
  }, [customerId]);
  useEffect(load, [load, reloadKey]);

  async function reverse(entryId) {
    try {
      await loyaltyApi.reverseEntry(entryId);
      toast.success(t('entryReversed'));
      load();
    } catch (e) { toast.error(apiErrorMessage(e, t('unableReverseEntry'))); }
  }

  const p = summary?.progress;
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title"><Award size={15} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />{t('loyalty')}</h3>
          <p className="card-subtitle">{t('tierBalancePointsHistory')}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {summary && <StatusBadge tone="warning" label={summary.tier_name || summary.tier} />}
          {canAdjust && (
            <button className="btn btn-secondary btn-sm" onClick={onAdjust}>
              <Award size={14} /> {t('adjustLoyalty')}
            </button>
          )}
        </div>
      </div>
      <div className="card-body">
        {summary && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 12 }}>
              <KV label={t('balance')}>{(summary.balance || 0).toLocaleString()}</KV>
              <KV label={t('earned')}>{(summary.earned || 0).toLocaleString()}</KV>
              <KV label={t('redeemed')}>{(summary.redeemed || 0).toLocaleString()}</KV>
              <KV label={t('expired')}>{(summary.expired || 0).toLocaleString()}</KV>
            </div>
            {p && (p.points_to_go > 0 || p.spend_to_go) && (
              <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                {t('reach')} <strong>{p.next_tier}</strong>:
                {p.points_to_go > 0 ? ` ${p.points_to_go} more points` : ''}
                {p.spend_to_go ? `${p.points_to_go > 0 ? ' ·' : ''} ${p.spend_to_go} more spend` : ''}.
              </div>
            )}
          </>
        )}
      </div>
      {rows === null ? (
        <div className="empty"><p>Loading…</p></div>
      ) : rows.length === 0 ? (
        <div className="empty"><p>{t('noLoyaltyActivityYet')}</p></div>
      ) : (
        <div className="table-wrapper">
          <table className="table">
            <thead><tr><th>{t('when')}</th><th>{t('typeLabel')}</th><th>{t('points')}</th><th>{t('balance')}</th><th>{t('sourceLabel')}</th><th>{t('note')}</th>{canReverse && <th></th>}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDate(r.created_at)}</td>
                  <td><StatusBadge tone={LEDGER_TONE[r.txn_type] || 'muted'} label={r.txn_type_display || r.txn_type} /></td>
                  <td style={{ fontWeight: 600, color: r.points < 0 ? 'var(--color-danger,#dc2626)' : 'inherit' }}>
                    {r.points > 0 ? `+${r.points}` : r.points}
                  </td>
                  <td>{r.balance_after}</td>
                  <td className="muted" style={{ textTransform: 'capitalize' }}>{r.source_display || r.source}</td>
                  <td className="muted" style={{ fontSize: 12.5 }}>{r.note}</td>
                  {canReverse && (
                    <td style={{ textAlign: 'right' }}>
                      {r.points !== 0 && (
                        <button className="link-btn" style={{ fontSize: 12 }} onClick={() => reverse(r.id)}>{t('reverse')}</button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CustomerActivity({ customerId }) {
  const { t } = useTranslation('customers');
  const [rows, setRows] = useState(null);
  useEffect(() => {
    customersApi.activity(customerId, { ordering: '-created_at' })
      .then((d) => setRows(d.results || d || []))
      .catch(() => setRows([]));
  }, [customerId]);
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title"><History size={15} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />{t('activityLog')}</h3>
          <p className="card-subtitle">{t('profileChangesCustomerWhoWhat')}</p>
        </div>
      </div>
      {rows === null ? (
        <div className="empty"><p>Loading…</p></div>
      ) : rows.length === 0 ? (
        <div className="empty"><p>{t('noActivityYet')}</p></div>
      ) : (
        <div className="table-wrapper">
          <table className="table">
            <thead><tr><th>{t('when')}</th><th>{t('action')}</th><th>By</th><th>{t('details')}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDate(r.created_at)}</td>
                  <td>{ACTIVITY_LABELS[r.event] || r.event || '-'}</td>
                  <td>{r.actor_name || r.payload_summary?.by_label || 'System'}</td>
                  <td><ActivityChanges p={r.payload_summary} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ActivityChanges({ p }) {
  const changes = p?.changes;
  if (changes && typeof changes === 'object') {
    return (
      <div style={{ fontSize: 12.5 }}>
        {Object.entries(changes).map(([f, v]) => (
          <div key={f}>
            <strong>{f.replace(/_/g, ' ')}:</strong>{' '}
            {v && typeof v === 'object' ? <>{String(v.from || '-')} → {String(v.to || '-')}</> : String(v)}
          </div>
        ))}
      </div>
    );
  }
  return <span className="muted">-</span>;
}

function KV({ icon: Icon, label, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '8px 0' }}>
      {Icon && <Icon size={16} style={{ marginTop: 2, color: 'var(--color-text-muted)' }} />}
      <div style={{ flex: 1 }}>
        <div className="muted" style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.06em' }}>
          {label}
        </div>
        <div style={{ fontWeight: 500 }}>{children}</div>
      </div>
    </div>
  );
}
