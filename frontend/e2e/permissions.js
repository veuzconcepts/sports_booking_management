// Generated from backend/apps/accounts/access.py MODULES.
// The e2e admin holds every capability, so a layout test is never skipped
// because a route happened to be permission-gated.
export const ALL_PERMISSIONS = [
    'audit.view', 'bookings.add', 'bookings.apply_subscription',
    'bookings.assign', 'bookings.assign_override', 'bookings.cancel',
    'bookings.delete', 'bookings.duplicate', 'bookings.edit',
    'bookings.reopen', 'bookings.skip_assignment',
    'bookings.unapply_subscription', 'bookings.view', 'clubs.add',
    'clubs.delete', 'clubs.edit', 'clubs.view', 'customers.add',
    'customers.delete', 'customers.edit', 'customers.merge',
    'customers.verify', 'customers.view', 'facilities.add',
    'facilities.delete', 'facilities.edit', 'facilities.view',
    'invoicing.add', 'invoicing.cancel_invoice', 'invoicing.credit',
    'invoicing.credit_approve', 'invoicing.view', 'loyalty.adjust',
    'loyalty.manage_rules', 'loyalty.manage_tiers', 'loyalty.redeem',
    'loyalty.reverse', 'loyalty.view', 'loyalty.view_ledger',
    'notifications.manage', 'notifications.view', 'organization.manage',
    'organization.view', 'payments.add', 'payments.delete',
    'payments.view', 'promotions.add', 'promotions.delete',
    'promotions.edit', 'promotions.view', 'reports.export', 'reports.view',
    'roles.add', 'roles.delete', 'roles.duplicate', 'roles.edit',
    'roles.view', 'settings.manage', 'settings.view', 'staff.activity',
    'staff.add', 'staff.club_history', 'staff.delete', 'staff.edit',
    'staff.reassign', 'staff.transfer', 'staff.transfer_approve',
    'staff.transfer_cancel', 'staff.view', 'subscriptions.add',
    'subscriptions.assign', 'subscriptions.cancel', 'subscriptions.delete',
    'subscriptions.edit', 'subscriptions.suspend',
    'subscriptions.usage_adjust', 'subscriptions.view', 'users.add',
    'users.delete', 'users.edit', 'users.view', 'website.edit',
    'website.media', 'website.publish', 'website.view'
];
