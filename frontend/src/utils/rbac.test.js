import { describe, expect, it } from 'vitest';

import { t } from '../i18n/index.js';

import {
  assignableBaseRoles,
  assignableRoleOptions,
  canManageUser,
  canTransferSuperAdmin,
  isSuperAdmin,
} from './rbac.js';

const superAdmin = { id: 1, role: 'super_admin', is_super_admin: true };
const admin = { id: 2, role: 'admin' };
const manager = { id: 3, role: 'manager' };

describe('isSuperAdmin', () => {
  it('matches only the super_admin role', () => {
    expect(isSuperAdmin(superAdmin)).toBe(true);
    expect(isSuperAdmin(admin)).toBe(false);
    expect(isSuperAdmin(null)).toBe(false);
  });
});

describe('assignableRoleOptions', () => {
  const roles = [
    { slug: 'super_admin', name: 'Super Admin', base_role: 'super_admin' },
    { slug: 'admin', name: 'Admin', base_role: 'admin' },
    { slug: 'club_admin', name: 'Club Admin', base_role: 'club_admin' },
    { slug: 'facility_staff', name: 'Facility Staff', base_role: 'facility_staff' },
  ];

  it('never offers the super_admin role', () => {
    const values = assignableRoleOptions(t, roles, superAdmin).map((o) => o.value);
    expect(values).not.toContain('super_admin');
  });

  it('offers admin-based roles only to a super admin', () => {
    expect(assignableRoleOptions(t, roles, superAdmin).map((o) => o.value)).toContain('admin');
    expect(assignableRoleOptions(t, roles, admin).map((o) => o.value)).not.toContain('admin');
  });

  it('keeps the club-scoped roles for a non-super admin', () => {
    const values = assignableRoleOptions(t, roles, admin).map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(['club_admin', 'facility_staff']));
  });

  it('falls back to the static role list when none are supplied', () => {
    expect(assignableRoleOptions(t, [], admin).length).toBeGreaterThan(0);
  });
});

describe('assignableBaseRoles', () => {
  it('hides super-admin-only bases from an ordinary admin', () => {
    const forAdmin = assignableBaseRoles(t, admin).map((b) => b.value);
    const forSuper = assignableBaseRoles(t, superAdmin).map((b) => b.value);
    expect(forAdmin).not.toContain('admin');
    expect(forSuper).toContain('admin');
  });

  it('offers the club-scoped staff tiers', () => {
    expect(assignableBaseRoles(t, admin).map((b) => b.value))
      .toEqual(expect.arrayContaining(['manager', 'facility_operator', 'facility_staff']));
  });
});

describe('canManageUser', () => {
  it('lets a super admin manage anyone', () => {
    expect(canManageUser(superAdmin, admin)).toBe(true);
    expect(canManageUser(superAdmin, superAdmin)).toBe(true);
  });

  it('stops a non-super admin managing a senior account', () => {
    expect(canManageUser(admin, superAdmin)).toBe(false);
    expect(canManageUser(manager, admin)).toBe(false);
  });

  it('allows managing a non-senior account', () => {
    expect(canManageUser(admin, manager)).toBe(true);
  });
});

describe('canTransferSuperAdmin', () => {
  const target = { id: 9, role: 'manager', is_active: true, is_deleted: false };

  it('is offered only by the super admin', () => {
    expect(canTransferSuperAdmin(superAdmin, target)).toBe(true);
    expect(canTransferSuperAdmin(admin, target)).toBe(false);
  });

  it('refuses self, inactive, deleted and customer targets', () => {
    expect(canTransferSuperAdmin(superAdmin, superAdmin)).toBe(false);
    expect(canTransferSuperAdmin(superAdmin, { ...target, is_active: false })).toBe(false);
    expect(canTransferSuperAdmin(superAdmin, { ...target, is_deleted: true })).toBe(false);
    expect(canTransferSuperAdmin(superAdmin, { ...target, role: 'customer' })).toBe(false);
  });
});
