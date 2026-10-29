import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appJwt } from './github-signing';

export interface GithubRepo { id: number; full_name: string; private: boolean; html_url: string }

/**
 * Calls the GitHub REST API as the GitHub App (SRS SI-4). Only read access to repository metadata is needed:
 * the app never reads source code. Settings: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (PEM; "\n" may be escaped).
 */
@Injectable()
export class GithubClient {
  private readonly api: string;
  private readonly appId?: string;
  private readonly key?: string;
  private readonly tokens = new Map<number, { token: string; expires: number }>();

  constructor(config: ConfigService) {
    this.api = (config.get<string>('GITHUB_API_URL') ?? 'https://api.github.com').replace(/\/$/, '');
    this.appId = config.get<string>('GITHUB_APP_ID');
    this.key = config.get<string>('GITHUB_APP_PRIVATE_KEY')?.replace(/\\n/g, '\n');
  }

  get configured() {
    return !!(this.appId && this.key);
  }

  /** The installation's account (organization or user) and when it was created. */
  installation(installationId: number) {
    return this.call<{ id: number; created_at: string; account: { login: string } }>('GET', `/app/installations/${installationId}`, this.jwt());
  }

  /** Every repository the installation can see (all pages). */
  async repositories(installationId: number) {
    const token = await this.installationToken(installationId);
    const repos: GithubRepo[] = [];
    for (let page = 1; page <= 20; page++) {
      const r = await this.call<{ repositories: GithubRepo[] }>('GET', `/installation/repositories?per_page=100&page=${page}`, token);
      repos.push(...r.repositories);
      if (r.repositories.length < 100) break;
    }
    return repos;
  }

  /** The installations the signed-in GitHub user can access (proves they own the one being connected). */
  userInstallations(userToken: string) {
    return this.call<{ installations: { id: number }[] }>('GET', '/user/installations?per_page=100', userToken);
  }

  /** Exchanges the OAuth code from the install redirect for a user token (needs GITHUB_CLIENT_ID / SECRET). */
  async userToken(clientId: string, clientSecret: string, code: string, oauthUrl = 'https://github.com/login/oauth/access_token') {
    const res = await fetch(oauthUrl, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }), signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { access_token?: string; error_description?: string };
    if (!body.access_token) throw new Error(`GitHub sign-in failed: ${body.error_description ?? res.status}`);
    return body.access_token;
  }

  private jwt() {
    if (!this.configured) throw new Error('GitHub is not configured on the server (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY)');
    return appJwt(this.appId!, this.key!);
  }

  /** Installation tokens last an hour; they are reused until a minute before they expire. */
  private async installationToken(installationId: number) {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;
    const r = await this.call<{ token: string; expires_at: string }>('POST', `/app/installations/${installationId}/access_tokens`, this.jwt());
    this.tokens.set(installationId, { token: r.token, expires: Date.parse(r.expires_at) });
    return r.token;
  }

  private async call<T>(method: string, path: string, bearer: string): Promise<T> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${bearer}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'pm-platform' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]}: ${res.status}`);
    return (await res.json()) as T;
  }
}
