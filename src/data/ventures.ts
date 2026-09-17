/**
 * Things Brandon owns, and where to find him. Shared by the marketing site and
 * the 3D world so the two never drift apart.
 */

export interface Venture {
  id: string;
  name: string;
  tagline: string;
  blurb: string;
  url: string;
  cta: string;
  /** Hex used for the pad and signage in the game. */
  accent: string;
  tags: string[];
  video?: string;
  poster?: string;
  /** External links open in a new tab; internal routes do not. */
  external: boolean;
}

export const ventures: Venture[] = [
  {
    id: 'axiom',
    name: 'Axiom',
    tagline: 'My company',
    blurb:
      'The studio the twenty client sites ship under, plus the billing platform that runs the back office — quotes, invoices and recurring billing in one place.',
    url: 'https://axiom-billing.vercel.app/',
    cta: 'Open Axiom',
    accent: '#2997ff',
    tags: ['Next.js', 'TypeScript', 'Postgres', 'Stripe'],
    video: '/video/axiom-demo.mp4',
    poster: '/video/axiom-poster.webp',
    external: true,
  },
  {
    id: 'drive',
    name: 'Drive My CV',
    tagline: 'This portfolio, as a game',
    blurb:
      'A drivable 3D world built on three.js and cannon-es: real vehicle physics, every client site standing as a billboard, and the CV waiting at the finish line.',
    url: '/drive',
    cta: 'Take it for a drive',
    accent: '#6cc0ff',
    tags: ['three.js', 'cannon-es', 'WebGL', 'Astro'],
    external: false,
  },
];

export interface Profile {
  id: string;
  name: string;
  handle: string;
  url: string;
  cta: string;
  accent: string;
}

export const profiles: Profile[] = [
  {
    id: 'linkedin',
    name: 'LinkedIn',
    handle: 'brandon-van-vuuren',
    url: 'https://www.linkedin.com/in/brandon-van-vuuren-9616841b6',
    cta: 'Connect on LinkedIn',
    accent: '#0a66c2',
  },
  {
    id: 'github',
    name: 'GitHub',
    handle: 'brandonvv-dev',
    url: 'https://github.com/brandonvv-dev',
    cta: 'Follow on GitHub',
    accent: '#8b949e',
  },
  {
    id: 'email',
    name: 'Hire me',
    handle: 'brandon.vanvuuren60@gmail.com',
    url: 'mailto:brandon.vanvuuren60@gmail.com',
    cta: 'Start a conversation',
    accent: '#34c759',
  },
];
