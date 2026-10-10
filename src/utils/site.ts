import { statSync } from 'node:fs';
import path from 'node:path';
import { moreSites } from '../data/more-sites';
import { projects } from '../data/projects';
import { sites } from '../data/sites';

export const email = 'brandon.vanvuuren60@gmail.com';

const cvFile = path.join(process.cwd(), 'public/assets/CV Brandon van Vuuren.pdf');

export const cv = {
  href: '/assets/CV%20Brandon%20van%20Vuuren.pdf',
  kb: Math.round(statSync(cvFile).size / 1024),
};

const shown = sites.length;
const listed = moreSites.length;

/** Every figure on the page is computed here from the data, never typed. */
export const counts = {
  projects: projects.filter((project) => project.featured).length,
  shown,
  listed,
  sites: shown + listed,
};

export const year = new Date().getFullYear();

/** 'https://www.example.com/a' becomes 'example.com'. */
export const host = (url: string): string => new URL(url).hostname.replace(/^www\./, '');
