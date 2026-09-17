import { Octokit } from 'octokit';

const octokit = new Octokit({ auth: import.meta.env.GITHUB_TOKEN });
const username = import.meta.env.GITHUB_USERNAME || 'Brandon255-rgb';

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
}

export async function getRecentRepos(limit = 12): Promise<GitHubRepo[]> {
  try {
    const { data } = await octokit.rest.repos.listForUser({
      username,
      sort: 'updated',
      per_page: limit,
      type: 'all',
    });

    return data.map((repo) => ({
      id: repo.id,
      name: repo.name,
      description: repo.description,
      html_url: repo.html_url,
      homepage: repo.homepage ?? null,
      language: repo.language ?? null,
      stargazers_count: repo.stargazers_count ?? 0,
      forks_count: repo.forks_count ?? 0,
      updated_at: repo.updated_at ?? new Date().toISOString(),
      topics: repo.topics ?? [],
      private: repo.private,
    }));
  } catch (error) {
    // A missing/expired token must not fail the build — the section just hides.
    console.error('GitHub fetch failed:', error);
    return [];
  }
}

export function formatDate(dateString: string): string {
  const days = Math.ceil(
    Math.abs(Date.now() - new Date(dateString).getTime()) / 86_400_000
  );

  if (days <= 1) return 'today';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}
