import { Octokit } from 'octokit';

const octokit = new Octokit({ auth: import.meta.env.GITHUB_TOKEN });
const username = import.meta.env.GITHUB_USERNAME || 'brandonvv-dev';

export const profileUrl = `https://github.com/${username}`;

export interface GitHubRepo {
  id: number;
  name: string;
  description: string | null;
  html_url: string;
  homepage: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  updated_at: string;
  topics: string[];
  private: boolean;
  fork: boolean;
}

/** The most recently updated public repositories the user wrote, at most `limit`. */
export async function getRecentRepos(limit = 12): Promise<GitHubRepo[]> {
  try {
    // The list endpoint cannot filter forks, so a full page is read and `limit` is applied after the filter.
    const { data } = await octokit.rest.repos.listForUser({
      username,
      sort: 'updated',
      per_page: 100,
      type: 'all',
    });

    return data
      .map((repo) => ({
        id: repo.id,
        name: repo.name,
        // Third-party copy: keep the home page free of dashes whatever GitHub holds.
        description: repo.description?.replace(/\s[–—]\s/g, ': ') ?? null,
        html_url: repo.html_url,
        homepage: repo.homepage ?? null,
        language: repo.language ?? null,
        stargazers_count: repo.stargazers_count ?? 0,
        forks_count: repo.forks_count ?? 0,
        updated_at: repo.updated_at ?? new Date().toISOString(),
        topics: repo.topics ?? [],
        private: repo.private,
        fork: repo.fork,
      }))
      .filter((repo) => !repo.fork && !repo.private)
      .slice(0, limit);
  } catch (error) {
    // A missing or expired token must not fail the build; the section just hides.
    console.error('GitHub fetch failed:', error);
    return [];
  }
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

/** 'today', '3 days ago', '1 week ago', '1 month ago', '2 years ago'. */
export function timeAgo(dateString: string): string {
  const days = Math.floor((Date.now() - new Date(dateString).getTime()) / 86_400_000);

  if (days < 1) return 'today';
  if (days < 7) return relative.format(-days, 'day');
  if (days < 30) return relative.format(-Math.floor(days / 7), 'week');
  if (days < 365) return relative.format(-Math.floor(days / 30), 'month');
  return relative.format(-Math.floor(days / 365), 'year');
}
