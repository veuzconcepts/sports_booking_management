import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import api from './services/apiClient.js';
import { AppLayout } from './layouts/AppLayout.jsx';
import { ProtectedRoute } from './routes/ProtectedRoute.jsx';
import { CurrencyProvider } from './services/currency.jsx';
import { TimeFormatProvider } from './services/timeformat.jsx';

// Route components are code-split (lazy) so each page is its own chunk and the
// initial bundle stays small. All are default exports.
const LoginPage = lazy(() => import('./pages/auth/LoginPage.jsx'));
const DashboardPage = lazy(() => import('./pages/DashboardPage.jsx'));
const ProfilePage = lazy(() => import('./pages/ProfilePage.jsx'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage.jsx'));

const CustomersListPage = lazy(() => import('./pages/customers/CustomersListPage.jsx'));
const CustomerDetailPage = lazy(() => import('./pages/customers/CustomerDetailPage.jsx'));
const FacilitiesPage = lazy(() => import('./pages/facilities/FacilitiesPage.jsx'));
const ClubsPage = lazy(() => import('./pages/settings/ClubsAndFacilities.jsx'));
const BookingsListPage = lazy(() => import('./pages/bookings/BookingsListPage.jsx'));
const BookingDetailPage = lazy(() => import('./pages/bookings/BookingDetailPage.jsx'));
const StaffListPage = lazy(() => import('./pages/staff/StaffListPage.jsx'));
const StaffDetailPage = lazy(() => import('./pages/staff/StaffDetailPage.jsx'));
const PaymentsPage = lazy(() => import('./pages/payments/PaymentsPage.jsx'));
const PaymentDetailPage = lazy(() => import('./pages/payments/PaymentDetailPage.jsx'));
const InvoicesListPage = lazy(() => import('./pages/payments/InvoicesListPage.jsx'));
const InvoiceDetailPage = lazy(() => import('./pages/payments/InvoiceDetailPage.jsx'));
const RefundsListPage = lazy(() => import('./pages/payments/RefundsListPage.jsx'));
const RefundDetailPage = lazy(() => import('./pages/payments/RefundDetailPage.jsx'));
const SubscriptionsPage = lazy(() => import('./pages/subscriptions/SubscriptionsPage.jsx'));
const ReportsPage = lazy(() => import('./pages/reports/ReportsPage.jsx'));
const NotificationsPage = lazy(() => import('./pages/notifications/NotificationsPage.jsx'));
const AuditLogsPage = lazy(() => import('./pages/auditlogs/AuditLogsPage.jsx'));
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage.jsx'));
const BookingConfigPage = lazy(() => import('./pages/settings/BookingConfiguration.jsx'));
const OrganizationInfoPage = lazy(() => import('./pages/organization/OrganizationInfoPage.jsx'));
const LoyaltyConfigPage = lazy(() => import('./pages/settings/LoyaltyConfiguration.jsx'));
const LoyaltyReportsPage = lazy(() => import('./pages/loyalty/LoyaltyReportsPage.jsx'));
const PromoCodesPage = lazy(() => import('./pages/promotions/PromoCodesPage.jsx'));
const PromoCodeDetailPage = lazy(() => import('./pages/promotions/PromoCodeDetailPage.jsx'));
const UsersPage = lazy(() => import('./pages/users/UsersPage.jsx'));
const RolesPage = lazy(() => import('./pages/roles/RolesPage.jsx'));
const RoleDetailPage = lazy(() => import('./pages/roles/RoleDetailPage.jsx'));
const WebsiteDashboard = lazy(() => import('./pages/website/WebsiteDashboard.jsx'));
const CmsResourcePage = lazy(() => import('./pages/website/CmsResourcePage.jsx'));
const MediaLibraryPage = lazy(() => import('./pages/website/MediaLibraryPage.jsx'));
const FooterSettingsPage = lazy(() => import('./pages/website/FooterSettingsPage.jsx'));

export default function App() {
  // Apply the organisation's uploaded favicon to the admin tab (public endpoint,
  // so it works even before login). Falls back to the bundled icon if none set.
  useEffect(() => {
    api.get('/website/public/branding/')
      .then((r) => {
        const href = r.data?.favicon;
        if (!href) return;
        let link = document.querySelector("link[rel~='icon']");
        if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
        link.setAttribute('href', href);
        link.setAttribute('type', href.toLowerCase().endsWith('.png') ? 'image/png' : '');
      })
      .catch(() => {});
  }, []);

  return (
    <Suspense fallback={<div className="center" style={{ height: '100vh' }}><div className="muted">Loading…</div></div>}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        element={
          <ProtectedRoute>
            <CurrencyProvider>
              <TimeFormatProvider>
                <AppLayout />
              </TimeFormatProvider>
            </CurrencyProvider>
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/profile"   element={<ProfilePage />} />

        {/* Customers */}
        <Route path="/customers"      element={<CustomersListPage />} />
        <Route path="/customers/:id"  element={<CustomerDetailPage />} />

        {/* Clubs & facilities */}
        <Route path="/facilities"  element={<ProtectedRoute perm="facilities.view"><FacilitiesPage /></ProtectedRoute>} />
        <Route path="/clubs"       element={<ProtectedRoute perm="clubs.view"><ClubsPage /></ProtectedRoute>} />
        <Route path="/promo-codes"     element={<ProtectedRoute perm="promotions.view"><PromoCodesPage /></ProtectedRoute>} />
        <Route path="/promo-codes/:id" element={<ProtectedRoute perm="promotions.view"><PromoCodeDetailPage /></ProtectedRoute>} />

        {/* Bookings */}
        <Route path="/bookings"      element={<BookingsListPage />} />
        <Route path="/bookings/:id"  element={<BookingDetailPage />} />

        {/* Staff & finance */}
        <Route path="/staff"      element={<StaffListPage />} />
        <Route path="/staff/:id"  element={<StaffDetailPage />} />
        <Route path="/payments"   element={<PaymentsPage />} />
        <Route path="/payments/:id" element={<PaymentDetailPage />} />
        <Route path="/invoices"      element={<InvoicesListPage />} />
        <Route path="/invoices/:id"  element={<InvoiceDetailPage />} />
        <Route path="/credit-notes"  element={<RefundsListPage />} />
        <Route path="/credit-notes/:id" element={<RefundDetailPage />} />
        <Route
          path="/subscriptions"
          element={
            <ProtectedRoute perm="subscriptions.view">
              <SubscriptionsPage />
            </ProtectedRoute>
          }
        />

        {/* Insights & administration */}
        <Route path="/reports"        element={<ReportsPage />} />
        <Route path="/notifications"  element={<NotificationsPage />} />
        <Route
          path="/auditlogs"
          element={
            <ProtectedRoute perm="audit.view">
              <AuditLogsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/organization"
          element={
            <ProtectedRoute perm="organization.view">
              <OrganizationInfoPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute perm="settings.manage">
              <SettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/booking-config"
          element={
            <ProtectedRoute perm="settings.manage">
              <BookingConfigPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/loyalty-config"
          element={
            <ProtectedRoute perm="loyalty.view">
              <LoyaltyConfigPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/loyalty-reports"
          element={
            <ProtectedRoute perm="loyalty.view_ledger">
              <LoyaltyReportsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/users"
          element={
            <ProtectedRoute perm="users.view">
              <UsersPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/roles"
          element={
            <ProtectedRoute perm="roles.view">
              <RolesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/roles/:slug"
          element={
            <ProtectedRoute perm="roles.view">
              <RoleDetailPage />
            </ProtectedRoute>
          }
        />

        {/* Customer website CMS */}
        <Route path="/website" element={<ProtectedRoute perm="website.view"><WebsiteDashboard /></ProtectedRoute>} />
        <Route path="/website/media" element={<ProtectedRoute perm="website.view"><MediaLibraryPage /></ProtectedRoute>} />
        <Route path="/website/footer" element={<ProtectedRoute perm="website.view"><FooterSettingsPage /></ProtectedRoute>} />
        <Route path="/website/:resource" element={<ProtectedRoute perm="website.view"><CmsResourcePage /></ProtectedRoute>} />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
    </Suspense>
  );
}
