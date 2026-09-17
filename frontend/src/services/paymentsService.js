import api from './apiClient';

export const paymentsApi = {
  list:   (params) => api.get('/payments/', { params }).then((r) => r.data),
  get:    (id)     => api.get(`/payments/${id}/`).then((r) => r.data),
  charge: (data)   => api.post('/payments/charge/', data).then((r) => r.data),
  // Refunds are issued from the Invoice (request-refund -> credit note), which
  // returns the money on the originating payment automatically.
  generateInvoice: (id) =>
    api.post(`/payments/${id}/generate-invoice/`).then((r) => r.data),
};

export const walletsApi = {
  list:  (params) => api.get('/payments/wallets/', { params }).then((r) => r.data),
  get:   (id)     => api.get(`/payments/wallets/${id}/`).then((r) => r.data),
  topUp: (customer, amount, note) =>
    api.post('/payments/wallets/top-up/', { customer, amount, note }).then((r) => r.data),
};

export const invoicesApi = {
  list: (params) => api.get('/payments/invoices/', { params }).then((r) => r.data),
  get:  (id) => api.get(`/payments/invoices/${id}/`).then((r) => r.data),
  generate: (bookingId) =>
    api.post('/payments/invoices/generate/', { booking: bookingId }).then((r) => r.data),
  // Cancel an UNPAID invoice issued in error.
  cancel: (id, reason) =>
    api.post(`/payments/invoices/${id}/cancel/`, { reason }).then((r) => r.data),
  // Request a refund (full/partial) against a PAID invoice -> creates a credit
  // note (the official refund document); processed now or on approval.
  requestRefund: (id, { amount, reason, method } = {}) =>
    api.post(`/payments/invoices/${id}/request-refund/`, { amount, reason, method }).then((r) => r.data),
  // Download streams a PDF - fetch as a blob so the browser can save it.
  download: (id) =>
    api.get(`/payments/invoices/${id}/download/`, { responseType: 'blob' }).then((r) => r.data),
};

export const receiptsApi = {
  list: (params) => api.get('/payments/receipts/', { params }).then((r) => r.data),
  download: (id) =>
    api.get(`/payments/receipts/${id}/download/`, { responseType: 'blob' }).then((r) => r.data),
};

export const creditNotesApi = {
  list: (params) => api.get('/payments/credit-notes/', { params }).then((r) => r.data),
  get:  (id) => api.get(`/payments/credit-notes/${id}/`).then((r) => r.data),
  approve: (id) => api.post(`/payments/credit-notes/${id}/approve/`).then((r) => r.data),
  reject: (id, remarks) =>
    api.post(`/payments/credit-notes/${id}/reject/`, { remarks }).then((r) => r.data),
  // Edit only the reason note - allowed even after the credit note is issued.
  updateReason: (id, reason) =>
    api.post(`/payments/credit-notes/${id}/update-reason/`, { reason }).then((r) => r.data),
  download: (id) =>
    api.get(`/payments/credit-notes/${id}/download/`, { responseType: 'blob' }).then((r) => r.data),
};

export const invoiceStatuses = (t) => [
  { value: 'issued',             label: t('payments:issued2') },
  { value: 'paid',               label: t('payments:paid') },
  { value: 'cancelled',          label: t('payments:cancelled') },
  { value: 'partially_refunded', label: t('payments:partiallyRefunded') },
  { value: 'refunded',           label: t('payments:refunded') },
];

// Shared status -> badge tone for invoices across pages.
export const INVOICE_STATUS_TONE = {
  issued: 'info', paid: 'success', cancelled: 'danger',
  partially_refunded: 'warning', refunded: 'muted',
};

// Credit note (refund document) status -> badge tone.
export const CREDIT_NOTE_STATUS_TONE = {
  pending_approval: 'warning', issued: 'success', rejected: 'danger',
};
export const creditNoteStatusLabels = (t) => ({
  pending_approval: 'Pending approval', issued: 'Issued', rejected: 'Rejected',
});
export const creditNoteStatuses = (t) => [
  { value: 'pending_approval', label: t('payments:pendingApproval') },
  { value: 'issued',           label: t('payments:issued2') },
  { value: 'rejected',         label: t('payments:rejected3') },
];

export const paymentMethods = (t) => [
  { value: 'card',       label: t('payments:card') },
  { value: 'cash',       label: t('payments:cash') },
  { value: 'wallet',     label: t('payments:wallet') },
  { value: 'membership', label: t('payments:membership') },
];

export const paymentStatuses = (t) => [
  { value: 'pending',             label: t('payments:pending') },
  { value: 'paid',                label: t('payments:paid') },
  { value: 'failed',              label: t('common:state.failed') },
  { value: 'refunded',            label: t('payments:refunded') },
  { value: 'partially_refunded',  label: t('payments:partiallyRefunded') },
];
