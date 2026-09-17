import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';

// On-demand SSR (Node adapter) so published CMS edits go live without a rebuild.
// The public site URL is set via SITE_URL (used for canonical/OG and, later, sitemap).
export default defineConfig({
  site: process.env.SITE_URL || 'http://localhost:4321',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [react()],
  server: { port: 4321, host: true },
  // Hide the Astro dev toolbar that floats at the bottom during `astro dev`.
  devToolbar: { enabled: false },
});
