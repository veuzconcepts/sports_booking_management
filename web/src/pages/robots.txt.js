// Public marketing site robots.txt - allow crawling of public pages, block the
// internal JSON proxy routes, and point to the sitemap. Pages that should not be
// indexed (e.g. the booking flow) carry their own `noindex` meta and are left
// crawlable here so engines can read that directive and drop them.
export function GET({ site }) {
  const origin = (site?.href || process.env.SITE_URL || '').replace(/\/$/, '');
  const lines = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
  ];
  if (origin) lines.push(`Sitemap: ${origin}/sitemap.xml`);
  return new Response(lines.join('\n') + '\n', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
