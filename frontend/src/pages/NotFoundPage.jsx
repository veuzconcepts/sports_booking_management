import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export default function NotFoundPage() {
  const { t } = useTranslation('common');
  return (
    <div className="center" style={{ minHeight: '100vh', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ fontSize: 56, margin: 0 }}>404</h1>
      <p className="muted">{t('weCouldnTFindPage')}</p>
      <Link className="btn btn-primary" to="/dashboard">{t('backDashboard')}</Link>
    </div>
  );
}
