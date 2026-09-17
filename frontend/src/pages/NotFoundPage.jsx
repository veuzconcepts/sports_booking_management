import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="center" style={{ minHeight: '100vh', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ fontSize: 56, margin: 0 }}>404</h1>
      <p className="muted">We couldn’t find the page you’re looking for.</p>
      <Link className="btn btn-primary" to="/dashboard">Back to dashboard</Link>
    </div>
  );
}
