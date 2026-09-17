/**
 * Pure RBAC helpers shared by the Users and Roles screens. Kept here (not inline)
 * so the access logic is unit-testable without rendering the pages. Each mirrors a
 * backend guard - the backend remains the source of truth; these only drive the UI.
 */
import { customBaseRoles, userRoles } from '../services/usersService.js';

export function isSuperAdmin(user) {
  return user?.role === 'super_admin';
}

/**
 * Roles the actor may assign in the user form. `super_admin` never appears
 * (moved only via the transfer action); only a super admin may assign an
 * admin-based role. Falls back to the static userRoles(t) when no dynamic roles.
 * Returns [{ value, label, base }].
 */
export function assignableRoleOptions(t, roles, actor) {
  const sup = isSuperAdmin(actor);
  const base = roles?.length
    ? roles.map((r) => ({ value: r.slug, label: r.name, base: r.base_role || r.slug }))
    : userRoles(t).map((r) => ({ value: r.value, label: r.label, base: r.value }));
  return base.filter((o) => o.base !== 'super_admin' && (sup || o.base !== 'admin'));
}

/** Behaviour bases offered in the New Role form; the admin (senior) base is
 *  super-admin-only. */
export function assignableBaseRoles(t, actor) {
  return customBaseRoles(t).filter((b) => !b.superOnly || isSuperAdmin(actor));
}

/** Mirror backend _guard_manage_target: only a super admin may act on an
 *  admin / super-admin account; everyone else manages only non-senior accounts. */
export function canManageUser(actor, target) {
  const senior = Boolean(target?.is_super_admin) || target?.role === 'admin';
  return isSuperAdmin(actor) || !senior;
}

/** Owner-only "Make super admin": only the super admin, targeting another active,
 *  non-deleted, non-customer account. */
export function canTransferSuperAdmin(actor, target) {
  return Boolean(
    isSuperAdmin(actor)
    && actor && target && target.id !== actor.id
    && target.is_active && !target.is_deleted && target.role !== 'customer',
  );
}
