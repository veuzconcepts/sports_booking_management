import api from './apiClient';

/**
 * The AI reporting assistant.
 *
 * Every call is answered by the backend from the signed-in user's own scope;
 * nothing here sends a club, an organization or a permission, because none of
 * those would be trusted if it did.
 */
export const insightsApi = {
  /** Whether the assistant is available, and what this user may ask about. */
  capabilities: () => api.get('/reports/ai/capabilities/').then((r) => r.data),

  /** Ask a question. `refresh` deliberately bypasses the cached answer. */
  ask: (question, sessionId, { refresh = false } = {}) =>
    api.post('/reports/ai/ask/', { question, session_id: sessionId, refresh })
      .then((r) => r.data),

  /** Start a new conversation. */
  clear: (sessionId) =>
    api.delete('/reports/ai/session/', { params: { session_id: sessionId } }),

  /**
   * Download a report the assistant already produced.
   *
   * Takes the report id rather than the question: the file must contain the
   * figures the user saw, and re-asking could produce different ones.
   */
  exportUrl: (reportId, fmt) =>
    `/reports/ai/export/?report_id=${encodeURIComponent(reportId)}&fmt=${fmt}`,

  download: (reportId, fmt) =>
    api.get('/reports/ai/export/', {
      params: { report_id: reportId, fmt },
      responseType: 'blob',
    }).then((r) => r.data),
};
