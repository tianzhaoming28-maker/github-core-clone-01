// The REST v3 surface: repositories, contents, branches, commits, refs,
// labels, issues, comments and pull requests, in GitHub's shapes and status
// codes. Handlers are pure functions of (forge, request) -> response so the
// HTTP plumbing in app.ts stays thin; the same forge operations back the
// GraphQL and MCP surfaces, which is what makes cross-surface reads agree.

import { ForgeError, type Forge, type Issue, type Pull, type Repo } from './forge.ts';
import { parseCommit } from './gitstore.ts';

/** A REST answer: a status and a JSON body (null for a body-less 204). */
export interface RestResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The pieces of a request the REST handlers read. */
export interface RestRequest {
  readonly method: string;
  /** Path segments after /api/v3, URL-decoded. */
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
  /** The parsed JSON body, or undefined when there was none. */
  readonly body: Record<string, unknown> | undefined;
  /** The request's absolute base (scheme://host), for pagination links. */
  readonly baseUrl: string;
  /** The request path (for pagination links). */
  readonly path: string;
}

/** A JSON error body in GitHub's shape. */
function errorBody(message: string): { message: string } {
  return { message };
}

/** Read a string field from a request body, or ''. */
function str(body: Record<string, unknown> | undefined, field: string): string {
  const value = body?.[field];
  return typeof value === 'string' ? value : '';
}

/** The repository's JSON shape. */
export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
  };
}

/** A label's JSON shape. */
function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', default: false };
}

/** An issue's JSON shape. */
export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: repo.owner, id: 1000, type: 'User' },
    comments: issue.comments.length,
  };
}

/** A comment's JSON shape. */
export function commentJson(repo: Repo, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${repo.id}_${comment.id}`,
    body: comment.body,
    user: { login: repo.owner, id: 1000, type: 'User' },
  };
}

/** A pull request's JSON shape; head/base shas are the branches' current tips. */
export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headTip = repo.branchTip(pull.head) ?? '';
  const baseTip = repo.branchTip(pull.base) ?? '';
  return {
    id: pull.id,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head, sha: headTip, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseTip, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: repo.owner, id: 1000, type: 'User' },
  };
}

/** Parse a positive integer query parameter, or the fallback. */
function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Slice `items` by page/per_page and build the Link header GitHub sends:
 * rel="next" while pages remain (same origin, absolute), rel="last", and
 * rel="prev"/"first" past page one.
 */
function paginate<T>(req: RestRequest, items: readonly T[]): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(100, intParam(req.query, 'per_page', 30));
  const pageNumber = intParam(req.query, 'page', 1);
  const start = (pageNumber - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  if (pageNumber < lastPage || start + perPage < items.length) {
    const params = new URLSearchParams(req.query);
    const links: string[] = [];
    const urlFor = (page: number): string => {
      params.set('page', String(page));
      params.set('per_page', String(perPage));
      return `${req.baseUrl}${req.path}?${params.toString()}`;
    };
    if (pageNumber < lastPage) {
      links.push(`<${urlFor(pageNumber + 1)}>; rel="next"`, `<${urlFor(lastPage)}>; rel="last"`);
    }
    if (pageNumber > 1) {
      links.push(`<${urlFor(pageNumber - 1)}>; rel="prev"`, `<${urlFor(1)}>; rel="first"`);
    }
    if (links.length) headers.link = links.join(', ');
  }
  return { page, headers };
}

// ---------------------------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------------------------

function createRepo(forge: Forge, req: RestRequest): RestResponse {
  const name = str(req.body, 'name');
  if (name === '') throw new ForgeError(422, 'Repository name is required');
  const repo = forge.createRepo({
    name,
    description: str(req.body, 'description'),
    private: req.body?.private === true,
    defaultBranch: str(req.body, 'default_branch') || undefined,
  });
  return { status: 201, body: repoJson(repo) };
}

function getRepo(forge: Forge, owner: string, name: string): RestResponse {
  return { status: 200, body: repoJson(forge.mustRepo(owner, name)) };
}

function patchRepo(forge: Forge, owner: string, name: string, req: RestRequest): RestResponse {
  const repo = forge.mustRepo(owner, name);
  if (typeof req.body?.description === 'string') repo.description = req.body.description;
  if (typeof req.body?.private === 'boolean') repo.isPrivate = req.body.private;
  if (typeof req.body?.name === 'string' && req.body.name !== '' && req.body.name !== name) {
    // A rename moves the map entry; nothing in the suite renames, but the
    // field is part of the surface, so answer it honestly.
    const renamed = forge.createRepo({ name: req.body.name, description: repo.description, private: repo.isPrivate });
    renamed.objects.clear();
    for (const [oid, object] of repo.objects) renamed.putKnown(oid, object);
    renamed.refs.clear();
    for (const [ref, oid] of repo.refs) renamed.refs.set(ref, oid);
    forge.deleteRepo(owner, name);
    return { status: 200, body: repoJson(renamed) };
  }
  return { status: 200, body: repoJson(repo) };
}

function contents(forge: Forge, owner: string, name: string, req: RestRequest, path: string): RestResponse {
  const repo = forge.mustRepo(owner, name);
  if (req.method === 'GET') {
    const ref = req.query.get('ref') ?? repo.defaultBranch;
    const found = forge.readContents(repo, ref, path);
    if (!found) throw new ForgeError(404, 'Not Found');
    if (found.kind === 'file') {
      const base = path.replace(/^\/+/, '');
      const fileName = base.split('/').pop() ?? base;
      return {
        status: 200,
        body: {
          type: 'file',
          encoding: 'base64',
          content: found.data.toString('base64'),
          name: fileName,
          path: base,
          sha: found.blob,
          size: found.data.length,
        },
      };
    }
    return {
      status: 200,
      body: found.entries.map((entry) => ({
        type: entry.type,
        name: entry.name,
        path: entry.path,
        sha: entry.sha,
        size: entry.size,
      })),
    };
  }
  if (req.method === 'PUT') {
    const content = str(req.body, 'content');
    const data = Buffer.from(content.replace(/\s+/g, ''), 'base64');
    const result = forge.putContents(repo, {
      path,
      content: data,
      message: str(req.body, 'message') || 'Update file',
      branch: str(req.body, 'branch') || undefined,
      sha: str(req.body, 'sha') || undefined,
    });
    const base = path.replace(/^\/+/, '');
    return {
      status: result.created ? 201 : 200,
      body: {
        content: {
          name: base.split('/').pop() ?? base,
          path: base,
          sha: result.blob,
          size: data.length,
          type: 'file',
          encoding: 'base64',
        },
        commit: { sha: result.commit, message: str(req.body, 'message') || 'Update file' },
      },
    };
  }
  if (req.method === 'DELETE') {
    const result = forge.deleteContents(repo, {
      path,
      message: str(req.body, 'message') || 'Delete file',
      branch: str(req.body, 'branch') || undefined,
      sha: str(req.body, 'sha') || undefined,
    });
    return { status: 200, body: { content: null, commit: { sha: result.commit, message: str(req.body, 'message') || 'Delete file' } } };
  }
  throw new ForgeError(404, 'Not Found');
}

function branches(forge: Forge, owner: string, name: string, req: RestRequest, branch: string | null): RestResponse {
  const repo = forge.mustRepo(owner, name);
  if (branch === null) {
    const list: Array<Record<string, unknown>> = [];
    for (const [ref, oid] of repo.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      list.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
    }
    list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { status: 200, body: list };
  }
  const tip = repo.branchTip(branch);
  if (!tip) throw new ForgeError(404, 'Not Found');
  return { status: 200, body: { name: branch, commit: { sha: tip }, protected: false } };
}

function commits(forge: Forge, owner: string, name: string, req: RestRequest, sha: string | null): RestResponse {
  const repo = forge.mustRepo(owner, name);
  const commitJsonOf = (row: { sha: string; message: string; author: string; committer: string; timestamp: number; parents: string[] }): Record<string, unknown> => ({
    sha: row.sha,
    commit: {
      message: row.message.replace(/\n$/, ''),
      author: { name: row.author.replace(/ <.*>$/, ''), email: /<([^>]*)>/.exec(row.author)?.[1] ?? '', date: new Date(row.timestamp * 1000).toISOString() },
      committer: { name: row.committer.replace(/ <.*>$/, ''), email: /<([^>]*)>/.exec(row.committer)?.[1] ?? '', date: new Date(row.timestamp * 1000).toISOString() },
    },
    parents: row.parents.map((parent) => ({ sha: parent })),
  });
  if (sha !== null) {
    const object = repo.objects.get(sha);
    if (!object || object.type !== 'commit') throw new ForgeError(404, 'Not Found');
    const parsed = parseCommit(object.data);
    return {
      status: 200,
      body: commitJsonOf({ sha, message: parsed.message, author: parsed.author, committer: parsed.committer, timestamp: parsed.timestamp, parents: parsed.parents }),
    };
  }
  const ref = req.query.get('sha') ?? repo.defaultBranch;
  const tip = forge.resolveRef(repo, ref);
  if (!tip) return { status: 200, body: [] };
  const rows = forge.listCommits(repo, tip).map(commitJsonOf);
  const { page, headers } = paginate(req, rows);
  return { status: 200, body: page, headers };
}

function gitRefs(forge: Forge, owner: string, name: string, req: RestRequest, refPath: string | null): RestResponse {
  const repo = forge.mustRepo(owner, name);
  if (req.method === 'POST' && refPath === null) {
    const ref = str(req.body, 'ref');
    const sha = str(req.body, 'sha');
    if (!ref.startsWith('refs/') || !repo.objects.has(sha)) throw new ForgeError(422, 'Invalid ref or object');
    if (repo.refs.has(ref)) throw new ForgeError(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    const object = repo.objects.get(sha)!;
    return { status: 201, body: { ref, node_id: `REF_${repo.id}`, object: { sha, type: object.type } } };
  }
  if (req.method === 'GET' && refPath === null) {
    const list: Array<Record<string, unknown>> = [];
    for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      list.push({ ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
    }
    return { status: 200, body: list };
  }
  if (req.method === 'GET' && refPath !== null) {
    const full = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
    const oid = repo.refs.get(full);
    if (!oid) throw new ForgeError(404, 'Not Found');
    return { status: 200, body: { ref: full, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } } };
  }
  if (req.method === 'DELETE' && refPath !== null) {
    const full = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
    if (!repo.refs.delete(full)) throw new ForgeError(404, 'Not Found');
    return { status: 204, body: null };
  }
  throw new ForgeError(404, 'Not Found');
}

function labels(forge: Forge, owner: string, name: string, req: RestRequest): RestResponse {
  const repo = forge.mustRepo(owner, name);
  if (req.method === 'POST') {
    const labelName = str(req.body, 'name');
    if (labelName === '') throw new ForgeError(422, 'Label name is required');
    const label = forge.createLabel(repo, labelName, str(req.body, 'color') || 'ededed');
    return { status: 201, body: { id: repo.id * 1000 + repo.labels.size, name: label.name, color: label.color, default: false } };
  }
  return { status: 200, body: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false })) };
}

function issues(forge: Forge, owner: string, name: string, req: RestRequest, number: number | null): RestResponse {
  const repo = forge.mustRepo(owner, name);
  if (number === null) {
    if (req.method === 'POST') {
      const title = str(req.body, 'title');
      if (title === '') throw new ForgeError(422, 'Title is required');
      const rawLabels = req.body?.labels;
      const labelNames: string[] = [];
      if (Array.isArray(rawLabels)) {
        for (const entry of rawLabels) {
          if (typeof entry === 'string') labelNames.push(entry);
          else if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') labelNames.push((entry as { name: string }).name);
        }
      }
      const issue = forge.createIssue(repo, {
        title,
        body: typeof req.body?.body === 'string' ? req.body.body : null,
        labels: labelNames,
      });
      return { status: 201, body: issueJson(repo, issue) };
    }
    const state = req.query.get('state') ?? 'open';
    const direction = req.query.get('direction') ?? 'desc';
    let list = [...repo.issues.values()];
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    const { page, headers } = paginate(req, list);
    return { status: 200, body: page.map((issue) => issueJson(repo, issue)), headers };
  }
  const issue = repo.issues.get(number);
  if (!issue) throw new ForgeError(404, 'Not Found');
  if (req.method === 'PATCH') {
    if (req.body?.state === 'closed' || req.body?.state === 'open') issue.state = req.body.state;
    if (typeof req.body?.title === 'string') issue.title = req.body.title;
    if (typeof req.body?.body === 'string') issue.body = req.body.body;
    return { status: 200, body: issueJson(repo, issue) };
  }
  return { status: 200, body: issueJson(repo, issue) };
}

function issueComments(forge: Forge, owner: string, name: string, req: RestRequest, number: number): RestResponse {
  const repo = forge.mustRepo(owner, name);
  const subject = repo.issues.get(number) ?? repo.pulls.get(number);
  if (!subject) throw new ForgeError(404, 'Not Found');
  if (req.method === 'POST') {
    const comment = forge.addComment(repo, number, str(req.body, 'body'));
    return { status: 201, body: commentJson(repo, comment) };
  }
  return { status: 200, body: subject.comments.map((comment) => commentJson(repo, comment)) };
}

function pulls(forge: Forge, owner: string, name: string, req: RestRequest, number: number | null): RestResponse {
  const repo = forge.mustRepo(owner, name);
  if (number === null) {
    if (req.method === 'POST') {
      const pull = forge.createPull(repo, {
        title: str(req.body, 'title'),
        body: typeof req.body?.body === 'string' ? req.body.body : null,
        head: str(req.body, 'head'),
        base: str(req.body, 'base') || repo.defaultBranch,
      });
      return { status: 201, body: pullJson(repo, pull) };
    }
    const state = req.query.get('state') ?? 'open';
    let list = [...repo.pulls.values()];
    if (state === 'open') list = list.filter((pull) => pull.state === 'open');
    else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
    list.sort((a, b) => a.number - b.number);
    const { page, headers } = paginate(req, list);
    return { status: 200, body: page.map((pull) => pullJson(repo, pull)), headers };
  }
  const pull = repo.pulls.get(number);
  if (!pull) throw new ForgeError(404, 'Not Found');
  return { status: 200, body: pullJson(repo, pull) };
}

function pullFiles(forge: Forge, owner: string, name: string, number: number): RestResponse {
  const repo = forge.mustRepo(owner, name);
  const pull = repo.pulls.get(number);
  if (!pull) throw new ForgeError(404, 'Not Found');
  return {
    status: 200,
    body: forge.pullFiles(repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    })),
  };
}

function pullMerge(forge: Forge, owner: string, name: string, req: RestRequest, number: number): RestResponse {
  const repo = forge.mustRepo(owner, name);
  const pull = repo.pulls.get(number);
  if (!pull) throw new ForgeError(404, 'Not Found');
  const method = str(req.body, 'merge_method') === 'merge' ? 'merge' : 'squash';
  const sha = forge.mergePull(repo, pull, method);
  return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

/**
 * Route one /api/v3 request. `segments` are the decoded path segments after
 * the prefix. Throws ForgeError for refusals; the caller renders them.
 */
export function routeRest(forge: Forge, req: RestRequest): RestResponse {
  const segments = req.segments;
  const method = req.method;
  try {
    if (segments.length === 0) {
      if (method !== 'GET') throw new ForgeError(404, 'Not Found');
      return {
        status: 200,
        body: {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_url: '/api/v3/repos/{owner}/{repo}/issues',
          rate_limit_url: '/api/v3/rate_limit',
        },
        headers: { 'x-oauth-scopes': 'repo, read:org' },
      };
    }
    if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
      return { status: 200, body: { installed_version: 'forge-1.0.0', git_version: 'forge', ruby_version: 'none' } };
    }
    if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
      const viewer = forge.viewer;
      return { status: 200, body: { login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email, type: 'User' } };
    }
    if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
      if (method === 'POST') return createRepo(forge, req);
      if (method === 'GET') {
        const { page, headers } = paginate(req, forge.listRepos());
        return { status: 200, body: page.map(repoJson), headers };
      }
      throw new ForgeError(404, 'Not Found');
    }
    if (segments[0] === 'repos' && segments.length >= 3) {
      const owner = segments[1];
      const name = segments[2];
      const rest = segments.slice(3);
      if (rest.length === 0) {
        if (method === 'GET') return getRepo(forge, owner, name);
        if (method === 'PATCH') return patchRepo(forge, owner, name, req);
        if (method === 'DELETE') {
          if (!forge.deleteRepo(owner, name)) throw new ForgeError(404, 'Not Found');
          return { status: 204, body: null };
        }
        throw new ForgeError(404, 'Not Found');
      }
      if (rest[0] === 'contents') return contents(forge, owner, name, req, rest.slice(1).join('/'));
      if (rest[0] === 'branches') {
        if (rest.length === 1 && method === 'GET') return branches(forge, owner, name, req, null);
        if (rest.length >= 2 && method === 'GET') return branches(forge, owner, name, req, rest.slice(1).join('/'));
        throw new ForgeError(404, 'Not Found');
      }
      if (rest[0] === 'commits') {
        if (rest.length === 1 && method === 'GET') return commits(forge, owner, name, req, null);
        if (rest.length === 2 && method === 'GET') return commits(forge, owner, name, req, rest[1]);
        throw new ForgeError(404, 'Not Found');
      }
      if (rest[0] === 'git' && rest[1] === 'refs') return gitRefs(forge, owner, name, req, rest.length > 2 ? rest.slice(2).join('/') : null);
      if (rest[0] === 'labels' && rest.length === 1) return labels(forge, owner, name, req);
      if (rest[0] === 'issues') {
        if (rest.length === 1) return issues(forge, owner, name, req, null);
        const number = Number.parseInt(rest[1], 10);
        if (!Number.isFinite(number)) throw new ForgeError(404, 'Not Found');
        if (rest.length === 2) return issues(forge, owner, name, req, number);
        if (rest.length === 3 && rest[2] === 'comments') return issueComments(forge, owner, name, req, number);
        throw new ForgeError(404, 'Not Found');
      }
      if (rest[0] === 'pulls') {
        if (rest.length === 1) return pulls(forge, owner, name, req, null);
        const number = Number.parseInt(rest[1], 10);
        if (!Number.isFinite(number)) throw new ForgeError(404, 'Not Found');
        if (rest.length === 2 && method === 'GET') return pulls(forge, owner, name, req, number);
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') return pullFiles(forge, owner, name, number);
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') return pullMerge(forge, owner, name, req, number);
        throw new ForgeError(404, 'Not Found');
      }
      throw new ForgeError(404, 'Not Found');
    }
    throw new ForgeError(404, 'Not Found');
  } catch (err) {
    if (err instanceof ForgeError) return { status: err.status, body: errorBody(err.message) };
    throw err;
  }
}
