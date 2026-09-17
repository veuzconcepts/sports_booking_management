import './listview.css';

/**
 * The standard listing page: one full-width workspace instead of a card
 * floating on a padded page.
 *
 * Title, toolbar, table and pagination share a single gutter, so a column
 * heading lines up with the page title above it and with the row count below
 * it. The table takes whatever height is left and scrolls inside itself, which
 * is what keeps the toolbar and the paging controls visible while someone works
 * through a long list.
 *
 *   <ListPage title={heading} subtitle={blurb} actions={<NewButton />}>
 *     <ListView ... />
 *   </ListPage>
 *
 * A page with tabs passes them as `tabs`; they join the header block rather
 * than sitting in the scrolling body, so switching tabs does not move the
 * heading. `wide` opts out of the fixed-height workspace for a page whose body
 * is not a single table (a tab that shows forms, say), keeping the alignment
 * without trapping the content in an inner scroller.
 */
export function ListPage({ title, subtitle, actions, tabs, wide = false, children }) {
  return (
    <div className={`lv-page${wide ? ' lv-page--flow' : ''}`}>
      <header className="lv-page__head">
        <div className="lv-page__titles">
          <h1 className="lv-page__title">{title}</h1>
          {subtitle && <p className="lv-page__subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="lv-page__actions">{actions}</div>}
      </header>
      {tabs}
      {children}
    </div>
  );
}
