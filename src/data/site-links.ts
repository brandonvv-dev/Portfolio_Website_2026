/**
 * Live URLs for the client sites, keyed by slug.
 *
 * Hand-maintained on purpose: src/data/sites.ts is generated from the
 * screenshot folders by scripts/build-site-assets.mjs and would lose anything
 * written into it. Add a slug here and the link appears in that site's gallery.
 */
export const siteLinks: Record<string, string> = {
  // 'eden-barbershop': 'https://edenbarbershop.co.za',
};
