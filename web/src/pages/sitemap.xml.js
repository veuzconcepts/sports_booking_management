// Sitemap for the PUBLIC marketing site only. We list public, indexable pages
// explicitly - never the booking flow (noindex), the JSON proxy routes, or any
// admin/internal URLs (those live in a separate app and are blocked there).
const PUBLIC_PATHS = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
];

export function GET({ site }) {
  const origin = (site?.href || process.env.SITE_URL || '').replace(/\/$/, '');
  const urls = PUBLIC_PATHS.map(({ path, changefreq, priority }) => (
    `  <url>\n    <loc>${origin}${path}</loc>\n` +
    `    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`
  )).join('\n');
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls + '\n</urlset>\n';
  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}
