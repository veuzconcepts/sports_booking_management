/**
 * The tab strip used across pages that hold several listings.
 *
 * Replaces five near-identical `tabBtnStyle` helpers, which were inline styles
 * and therefore could neither carry a media query nor announce themselves: a
 * screen reader met a row of unlabelled buttons. These are a real tablist, and
 * the active tab is expressed with `aria-selected` rather than colour alone.
 *
 *   <PageTabs tabs={[{ key: 'log', label: logLabel }]} active={tab} onChange={setTab} />
 */
export function PageTabs({ tabs, active, onChange, label }) {
  return (
    <div className="page-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          id={`tab-${tab.key}`}
          aria-selected={active === tab.key}
          className={`page-tab${active === tab.key ? ' is-active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {tab.count != null && <span className="page-tab__count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
