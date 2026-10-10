/**
 * Live URLs for the client sites, keyed by slug.
 *
 * Hand-maintained on purpose: src/data/sites.ts is generated from the
 * screenshot folders by scripts/build-site-assets.mjs and would lose anything
 * written into it. Add a slug here and the link appears in that site's gallery
 * and on its billboard in the game. A site that has gone from Vercel has no key,
 * so its gallery drops the link and its pad has no E prompt.
 */
export const siteLinks: Record<string, string> = {
  'makeup-by-thelma': 'https://makeup-by-thelma.vercel.app',
  'the-barber-at-rafters-hairstyles': 'https://the-barber-at-rafters-hairstyles.vercel.app',
  'cutting-crew-hair-studio': 'https://cutting-crew-hair-studio.vercel.app',
  'shara-hair-and-beauty-unisex-salon': 'https://shara-hair-beauty-unisex-salon.vercel.app',
  'ilan-motors-cc': 'https://ilan-motors-cc.vercel.app',
  'la-mich-hair-and-beauty-salon': 'https://la-mich-hair-beauty-salon.vercel.app',
  'jansens-meat-market': 'https://jansens-meat-market.vercel.app',
  'rocher-hair-studio': 'https://rocher-hair-studio.vercel.app',
  'opulent-dental-studio': 'https://opulent-dental-studio.vercel.app',
  'mellow-spa-sandton': 'https://mellow-spa-sandton.vercel.app',
  'studio-29-hair-beauty-and-nail-salon': 'https://studio-29-hair-beauty-nail-salon.vercel.app',
  'gardean-auto-and-diagnostics': 'https://gardean-auto-diagnostics.vercel.app',
  'jtrading-electrical-services': 'https://jtrading-electrical-services.vercel.app',
};
