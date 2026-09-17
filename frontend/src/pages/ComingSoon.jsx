import { Construction } from 'lucide-react';

import { PageHeader } from '../components/PageHeader.jsx';

/**
 * Used by modules slated for later phases. Keeps the navigation usable in
 * Phase 1 and serves as a visual stub so reviewers can click around.
 */
export default function ComingSoon({ title, subtitle, phase }) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="card">
        <div className="empty" style={{ padding: 64 }}>
          <Construction size={42} color="var(--color-text-muted)" />
          <h3 style={{ marginTop: 14 }}>{title} arrives in {phase}</h3>
          <p>
            This module is part of the staged delivery plan. Backend endpoints, list
            views, forms, and detail screens are wired up in {phase}.
          </p>
        </div>
      </div>
    </>
  );
}
