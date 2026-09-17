import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
  Languages,
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
  Megaphone,
  Gift,
} from 'lucide-react';

import { useAuth } from '../hooks/useAuth.jsx';

/**
 * Primary sections live in the left rail; each section's items (and any
 * collapsible sub-groups) render in the right panel.
 *   item:  { to, labelKey, icon }
 *   group: { group: <id>, labelKey, icon, children: [{ to, labelKey }] }
 *
 * `labelKey` is a key in the `navigation` namespace, resolved at render, so
 * the tree stays one data structure rather than one per language.
 */
const SECTIONS = [
  {
    key: 'dashboard', labelKey: 'sections.dashboard', icon: LayoutDashboard,
    items: [{ to: '/dashboard', labelKey: 'items.overview', icon: LayoutDashboard }],
  },
  {
    key: 'operations', labelKey: 'sections.operations', icon: CalendarCheck,
    items: [
      { to: '/bookings', labelKey: 'items.bookings', icon: CalendarCheck, perm: 'bookings.view' },
      { to: '/staff', labelKey: 'items.staff', icon: HardHat, perm: 'staff.view' },
      { to: '/customers', labelKey: 'items.customers', icon: Users, perm: 'customers.view' },
      {
        group: 'catalogue', labelKey: 'groups.catalogue', icon: LayoutGrid,
        children: [
          { to: '/clubs', labelKey: 'items.clubs', perm: 'clubs.view' },
          { to: '/facilities', labelKey: 'items.facilities', perm: 'facilities.view' },
          { to: '/subscriptions', labelKey: 'items.subscriptions', perm: 'subscriptions.view' },
        ],
      },
      { to: '/promo-codes', labelKey: 'items.promoCodes', icon: Ticket, perm: 'promotions.view' },
    ],
  },
  {
    key: 'finance', labelKey: 'sections.finance', icon: CreditCard,
    items: [
      { to: '/invoices', labelKey: 'items.invoices', icon: FileText, perm: 'invoicing.view' },
      { to: '/credit-notes', labelKey: 'items.creditNotes', icon: RotateCcw, perm: 'invoicing.view' },
      { to: '/payments', labelKey: 'items.payments', icon: CreditCard },
    ],
  },
  {
    key: 'insights', labelKey: 'sections.insights', icon: BarChart3,
    items: [
      { to: '/reports', labelKey: 'items.reports', icon: BarChart3 },
      { to: '/loyalty-reports', labelKey: 'items.loyaltyReports', icon: Gift, perm: 'loyalty.view_ledger' },
      { to: '/notifications', labelKey: 'items.notifications', icon: Bell },
    ],
  },
  {
    // Capability-gated, not role-gated: each link shows when the user holds its
    // permission, so a created role granted the capability sees it.
    key: 'admin', labelKey: 'sections.admin', icon: Settings,
    items: [
      { to: '/organization', labelKey: 'items.organization', icon: Building2, perm: 'organization.view' },
      { to: '/users', labelKey: 'items.users', icon: UserCog, perm: 'users.view' },
      { to: '/roles', labelKey: 'items.roles', icon: KeyRound, perm: 'roles.view' },
      { to: '/auditlogs', labelKey: 'items.auditLogs', icon: ShieldCheck, perm: 'audit.view' },
      { to: '/settings', labelKey: 'items.systemSettings', icon: Settings, perm: 'settings.manage' },
      { to: '/languages', labelKey: 'items.languages', icon: Languages, perm: 'settings.view' },
      { to: '/booking-config', labelKey: 'items.bookingConfig', icon: CalendarCheck, perm: 'settings.manage' },
      { to: '/loyalty-config', labelKey: 'items.loyalty', icon: Gift, perm: 'loyalty.view' },
    ],
  },
  {
    // Customer-website CMS - each item shows only with the website.view capability.
    key: 'website', labelKey: 'sections.website', icon: Globe,
    items: [
      { to: '/website', labelKey: 'items.websiteDashboard', icon: LayoutDashboard, perm: 'website.view' },
      {
        group: 'website-home', labelKey: 'groups.websiteHome', icon: Home,
        children: [
          { to: '/website/sections', labelKey: 'items.homeSections', perm: 'website.view' },
          { to: '/website/banners', labelKey: 'items.banners', perm: 'website.view' },
          { to: '/website/process-steps', labelKey: 'items.processSteps', perm: 'website.view' },
          { to: '/website/why-choose-us', labelKey: 'items.whyChooseUs', perm: 'website.view' },
          { to: '/website/stats', labelKey: 'items.stats', perm: 'website.view' },
          { to: '/website/testimonials', labelKey: 'items.testimonials', perm: 'website.view' },
          { to: '/website/brands', labelKey: 'items.brands', perm: 'website.view' },
        ],
      },
      { to: '/website/campaigns', labelKey: 'items.campaigns', icon: Megaphone, perm: 'website.view' },
      { to: '/website/faqs', labelKey: 'items.faqs', icon: FileText, perm: 'website.view' },
      { to: '/website/footer', labelKey: 'items.footer', icon: FileText, perm: 'website.view' },
      { to: '/website/seo', labelKey: 'items.seo', icon: Search, perm: 'website.view' },
      { to: '/website/media', labelKey: 'items.media', icon: Images, perm: 'website.view' },
    ],
  },
];

const allLinks = (section) =>
  section.items.flatMap((it) => (it.group ? it.children : [it]));

export function Sidebar({ open = false, collapsed = false, onToggleCollapse, onNavigate }) {
  const { t } = useTranslation('navigation');
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
        aria-label={collapsed ? t('expandMenu') : t('collapseMenu')}
        title={collapsed ? t('expandMenu') : t('collapseMenu')}
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
              <span>{t(s.labelKey)}</span>
            </button>
          );
        })}
        <div className="nav-rail-spacer" />
        <NavLink to="/search" className="nav-rail-item" onClick={(e) => e.preventDefault()}>
          <Search />
          <span>{t('common:actions.search')}</span>
        </NavLink>
      </div>

      {/* Right panel: selected section */}
      <div className="nav-panel">
        <div className="nav-panel-title">{active ? t(active.labelKey) : ''}</div>
        {active?.items.map((it) => {
          if (it.group) {
            const open = groupOpen(it.group);
            const Icon = it.icon;
            return (
              <div key={it.group}>
                <button className="nav-group-header" onClick={() => toggleGroup(it.group)}>
                  {Icon && <Icon className="lead" />}
                  <span>{t(it.labelKey)}</span>
                  <ChevronDown className={`nav-group-chevron ${open ? 'open' : ''}`} />
                </button>
                {open && (
                  <div className="nav-group-children">
                    {it.children.map((c) => (
                      <NavLink key={c.to} to={c.to} onClick={() => onNavigate?.()}
                        className={({ isActive }) => `nav-sublink ${isActive ? 'active' : ''}`}>
                        {t(c.labelKey)}
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
              <span>{t(it.labelKey)}</span>
            </NavLink>
          );
        })}
      </div>
    </aside>
  );
}
