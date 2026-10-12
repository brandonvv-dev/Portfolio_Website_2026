import tailwind from '@astrojs/tailwind';
import vercel from '@astrojs/vercel';
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';

export default defineConfig({
  integrations: [tailwind(), react()],
  site: 'https://www.brandonvv.com',
  // Static by default: only routes that export `prerender = false` run as serverless functions.
  output: 'static',
  adapter: vercel(),
  build: {
    inlineStylesheets: 'auto'
  }
});
