import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  LayoutGrid,
  CalendarCheck,
  HardHat,
  CreditCard,
  BarChart3,
  Bell,
  Settings,
  ShieldCheck,
  UserCog,
  KeyRound,
  Building2,
  Ticket,
  FileText,
  RotateCcw,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
  Globe,
  Home,
  Images,
  Gift,
} from 'lucide-react';

import { useAuth } from '../hooks/useAuth.jsx';

/**
 * Primary sections live in the left rail; each section's items (and any
 * collapsible sub-groups) render in the right panel.
 *   item:  { to, label, icon }
 *   group: { group: <id>, label, icon, children: [{ to, label }] }
 */
const SECTIONS = [
  {
    key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard,
    items: [{ to: '/dashboard', label: 'Overview', icon: LayoutDashboard }],
  },
  {
    key: 'operations', label: 'Operations', icon: CalendarCheck,
    items: [
      { to: '/bookings', label: 'Bookings', icon: CalendarCheck, perm: 'bookings.view' },
      { to: '/staff', label: 'Staff & Shifts', icon: HardHat, perm: 'staff.view' },
      { to: '/customers', label: 'Customers', icon: Users, perm: 'customers.view' },
      {
        group: 'catalogue', label: 'Clubs & Facilities', icon: LayoutGrid,
        children: [
          { to: '/clubs', label: 'Clubs & Facilities', perm: 'clubs.view' },
          { to: '/facilities', label: 'Catalogue & Pricing', perm: 'facilities.view' },
          { to: '/subscriptions', label: 'Memberships', perm: 'subscriptions.view' },
        ],
      },
      { to: '/promo-codes', label: 'Promo Codes', icon: Ticket, perm: 'promotions.view' },
    ],
  },
  {
    key: 'finance', label: 'Finance', icon: CreditCard,
    items: [
      { to: '/invoices', label: 'Invoices', icon: FileText, perm: 'invoicing.view' },
      { to: '/credit-notes', label: 'Refunds', icon: RotateCcw, perm: 'invoicing.view' },
      { to: '/payments', label: 'Payments', icon: CreditCard },
    ],
  },
  {
    key: 'insights', label: 'Insights', icon: BarChart3,
    items: [
      { to: '/reports', label: 'Reports', icon: BarChart3 },
      { to: '/loyalty-reports', label: 'Loyalty Reports', icon: Gift, perm: 'loyalty.view_ledger' },
      { to: '/notifications', label: 'Notifications', icon: Bell },
    ],
  },
  {
    // Capability-gated, not role-gated: each link shows when the user holds its
    // permission, so a created role granted the capability sees it.
    key: 'admin', label: 'Settings', icon: Settings,
    items: [
      { to: '/organization', label: 'Organization Info', icon: Building2, perm: 'organization.view' },
      { to: '/users', label: 'Users', icon: UserCog, perm: 'users.view' },
      { to: '/roles', label: 'Roles & Permissions', icon: KeyRound, perm: 'roles.view' },
      { to: '/auditlogs', label: 'Audit Logs', icon: ShieldCheck, perm: 'audit.view' },
      { to: '/settings', label: 'System Settings', icon: Settings, perm: 'settings.manage' },
      { to: '/booking-config', label: 'Booking Configuration', icon: CalendarCheck, perm: 'settings.manage' },
      { to: '/loyalty-config', label: 'Loyalty', icon: Gift, perm: 'loyalty.view' },
    ],
  },
  {
    // Customer-website CMS - each item shows only with the website.view capability.
    key: 'website', label: 'Website', icon: Globe,
    items: [
      { to: '/website', label: 'Dashboard', icon: LayoutDashboard, perm: 'website.view' },
      {
        group: 'website-home', label: 'Home', icon: Home,
        children: [
          { to: '/website/sections', label: 'Home Sections', perm: 'website.view' },
          { to: '/website/banners', label: 'Hero Banners', perm: 'website.view' },
          { to: '/website/process-steps', label: 'How It Works', perm: 'website.view' },
          { to: '/website/why-choose-us', label: 'Why Choose Us', perm: 'website.view' },
          { to: '/website/stats', label: 'Stats', perm: 'website.view' },
          { to: '/website/testimonials', label: 'Testimonials', perm: 'website.view' },
          { to: '/website/brands', label: 'Trusted Brands', perm: 'website.view' },
        ],
      },
      { to: '/website/faqs', label: 'FAQ', icon: FileText, perm: 'website.view' },
      { to: '/website/footer', label: 'Footer', icon: FileText, perm: 'website.view' },
      { to: '/website/seo', label: 'SEO Settings', icon: Search, perm: 'website.view' },
      { to: '/website/media', label: 'Media Library', icon: Images, perm: 'website.view' },
    ],
  },
];

const allLinks = (section) =>
  section.items.flatMap((it) => (it.group ? it.children : [it]));

export function Sidebar({ open = false, collapsed = false, onToggleCollapse, onNavigate }) {
  const { role, hasPerm } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  // A link shows if it has a `perm` the user holds; otherwise it follows the
  // section's role gate. So an admin-area item like Organization Info can be
  // granted to a non-admin role via its permission, without opening the rest.
  const linkVisible = (link, roleOk) => {
    if (link.roles) return link.roles.includes(role);   // explicit per-link role gate
    return link.perm ? hasPerm(link.perm) : roleOk;
  };
  const sections = SECTIONS.map((s) => {
    const roleOk = !s.roles || s.roles.includes(role);
    const items = s.items
      .map((it) => (it.group
        ? { ...it, children: it.children.filter((c) => linkVisible(c, roleOk)) }
        : it))
      .filter((it) => (it.group ? it.children.length : linkVisible(it, roleOk)));
    return { ...s, items };
  }).filter((s) => s.items.length);

  const sectionForPath = (path) =>
    sections.find((s) => allLinks(s).some((l) => path.startsWith(l.to)))?.key;

  const [activeKey, setActiveKey] = useState(() => sectionForPath(pathname) || sections[0]?.key);
  const [openGroups, setOpenGroups] = useState({});

  // Keep the rail in sync when navigation changes the route.
  useEffect(() => {
    const k = sectionForPath(pathname);
    if (k) setActiveKey(k);
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = sections.find((s) => s.key === activeKey) || sections[0];

  function selectSection(section) {
    setActiveKey(section.key);
    const links = allLinks(section);
    // Reveal the panel if it was collapsed and there's a submenu to show.
    if (collapsed && links.length > 1) onToggleCollapse?.();
    // Clicking a top-level menu defaults to its FIRST submenu (unless we're
    // already somewhere inside that section).
    const alreadyInside = links.some((l) => pathname.startsWith(l.to));
    if (links.length && !alreadyInside) { navigate(links[0].to); onNavigate?.(); }
  }

  function toggleGroup(id) {
    setOpenGroups((prev) => ({ ...prev, [id]: !groupOpen(id) }));
  }
  // A group is open if explicitly toggled, else auto-open when it holds the route.
  function groupOpen(id) {
    if (id in openGroups) return openGroups[id];
    const grp = active?.items.find((it) => it.group === id);
    return grp ? grp.children.some((c) => pathname.startsWith(c.to)) : false;
  }

  return (
    <aside className={`nav ${open ? 'open' : ''} ${collapsed ? 'collapsed' : ''}`}>
      {/* Collapse / expand the 2nd panel */}
      <button
        className="nav-collapse-toggle"
        onClick={onToggleCollapse}
        aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
        title={collapsed ? 'Expand menu' : 'Collapse menu'}
      >
        {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
      </button>

      {/* Left rail */}
      <div className="nav-rail">
        {sections.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.key}
              className={`nav-rail-item ${activeKey === s.key ? 'active' : ''}`}
              onClick={() => selectSection(s)}
            >
              <Icon />
              <span>{s.label}</span>
            </button>
          );
        })}
        <div className="nav-rail-spacer" />
        <NavLink to="/search" className="nav-rail-item" onClick={(e) => e.preventDefault()}>
          <Search />
          <span>Search</span>
        </NavLink>
      </div>

      {/* Right panel: selected section */}
      <div className="nav-panel">
        <div className="nav-panel-title">{active?.label}</div>
        {active?.items.map((it) => {
          if (it.group) {
            const open = groupOpen(it.group);
            const Icon = it.icon;
            return (
              <div key={it.group}>
                <button className="nav-group-header" onClick={() => toggleGroup(it.group)}>
                  {Icon && <Icon className="lead" />}
                  <span>{it.label}</span>
                  <ChevronDown className={`nav-group-chevron ${open ? 'open' : ''}`} />
                </button>
                {open && (
                  <div className="nav-group-children">
                    {it.children.map((c) => (
                      <NavLink key={c.to} to={c.to} onClick={() => onNavigate?.()}
                        className={({ isActive }) => `nav-sublink ${isActive ? 'active' : ''}`}>
                        {c.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          const Icon = it.icon;
          return (
            <NavLink key={it.to} to={it.to} onClick={() => onNavigate?.()}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              {Icon && <Icon />}
              <span>{it.label}</span>
            </NavLink>
          );
        })}
      </div>
    </aside>
  );
}
