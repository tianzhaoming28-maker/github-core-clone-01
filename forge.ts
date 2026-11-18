// The forge's domain store: repositories (with their git objects and refs),
// labels, issues, comments and pull requests, held in memory and shared by
// every surface — REST, GraphQL, MCP and the git wire all read and write the
// same records, so an object made on one surface is the same object on all.
//
// Time is a counter, not a clock: the store starts at MAKEFUN_TRIAL_NOW when
// the env provides it (else a fixed epoch) and advances one second per
// stamped event. A run that performs the same operations therefore produces
// the same commit ids, which is what the suite's replay determinism asks of
// an entry.

import {
  GitError,
  ZERO_OID,
  buildCommit,
  buildTreeFromFlat,
  collectReachable,
  commitAncestors,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  lineDiffCounts,
  mergeBase,
  mergeTrees,
  parseCommit,
  parseTree,
  peelTag,
  peelToCommit,
  readPack,
  writePack,
  type FlatFile,
  type GitObject,
  type GitObjectType,
} from './gitstore.ts';
import { VIEWER, type ForgeUser } from './scenario.ts';

/** A refusal the API surfaces translate into a status code and a message. */
export class ForgeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ForgeError';
    this.status = status;
  }
}

/** One label on a repository. */
export interface Label {
  readonly name: string;
  readonly color: string;
}

/** One issue comment. */
export interface Comment {
  readonly id: number;
  readonly body: string;
}

/** One issue. `number` is the per-repository sequence issues and pulls share. */
export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  readonly seq: number;
}

/** One pull request. */
export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string | null;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: Comment[];
  readonly seq: number;
}

/** One repository: its metadata, its git store, and its trackers. */
export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  /** object id -> object, this repository's whole git store. */
  readonly objects = new Map<string, GitObject>();
  /** Insertion order per object, for deterministic commit listings. */
  readonly objectSeq = new Map<string, number>();
  private objectCounter = 0;
  /** full ref name (refs/heads/main) -> object id. */
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  /** The sequence issue and pull numbers share, as on GitHub. */
  nextNumber = 1;
  /** Comment ids are per-repository and shared by issues and pulls. */
  nextCommentId = 1;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, defaultBranch: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = defaultBranch;
  }

  /** This repository's object lookup, in the shape the git walks take. */
  readonly lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  /** Hash and store an object (idempotently); answers its id. */
  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      this.objectSeq.set(oid, this.objectCounter);
      this.objectCounter += 1;
    }
    return oid;
  }

  /** Store an already-hashed object (a pack entry), keeping insertion order. */
  putKnown(oid: string, object: GitObject): void {
    if (!this.objects.has(oid)) {
      this.objects.set(oid, object);
      this.objectSeq.set(oid, this.objectCounter);
      this.objectCounter += 1;
    }
  }

  /** The current tip of a branch, or null when the branch does not exist. */
  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The tree a commit names. */
  commitTree(commitOid: string): string {
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') throw new ForgeError(422, `object ${commitOid} is not a commit`);
    return parseCommit(object.data).tree;
  }

  /** The flattened files of a commit. */
  commitFiles(commitOid: string): Map<string, FlatFile> {
    return flattenTree(this.lookup, this.commitTree(commitOid));
  }
}

/** Everything the forge holds. One instance per process. */
export class Forge {
  readonly viewer: ForgeUser = VIEWER;
  private readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private readonly clockBaseSec: number;
  private clockTicks = 0;
  /** Pack bytes for repeated identical fetches (the clone benchmark asks 50 times). */
  private readonly packCache = new Map<string, Buffer>();

  constructor() {
    const trialNow = process.env.MAKEFUN_TRIAL_NOW;
    const parsed = trialNow ? Date.parse(trialNow) : Number.NaN;
    this.clockBaseSec = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1_700_000_000;
  }

  /** The next deterministic timestamp: unix seconds and its ISO spelling. */
  tick(): { sec: number; iso: string } {
    const sec = this.clockBaseSec + this.clockTicks;
    this.clockTicks += 1;
    return { sec, iso: new Date(sec * 1000).toISOString() };
  }

  /** The identity line contents for commits this forge authors. */
  private identity(): string {
    return `${this.viewer.name} <${this.viewer.email}>`;
  }

  // -------------------------------------------------------------------------------------------
  // repositories
  // -------------------------------------------------------------------------------------------

  /** Create a repository for the token's owner. Throws 422 when the name is taken. */
  createRepo(fields: { name: string; description?: string; private?: boolean; defaultBranch?: string }): Repo {
    const key = `${this.viewer.login}/${fields.name}`;
    if (this.repos.has(key)) throw new ForgeError(422, 'Repository already exists');
    const repo = new Repo(
      this.nextRepoId,
      this.viewer.login,
      fields.name,
      fields.description ?? '',
      fields.private ?? false,
      fields.defaultBranch && fields.defaultBranch !== '' ? fields.defaultBranch : 'main',
    );
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  /** Find a repository by owner and name; null when it is not the viewer's or does not exist. */
  repo(owner: string, name: string): Repo | null {
    if (owner !== this.viewer.login) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  /** Find a repository or throw the 404 every surface answers. */
  mustRepo(owner: string, name: string): Repo {
    const repo = this.repo(owner, name);
    if (!repo) throw new ForgeError(404, 'Not Found');
    return repo;
  }

  /** Delete a repository; false when it did not exist. */
  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.viewer.login) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  /** All of the viewer's repositories, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  // -------------------------------------------------------------------------------------------
  // commits authored by the forge (contents writes and merges)
  // -------------------------------------------------------------------------------------------

  /**
   * Commit a flattened file set on top of `parent` (or as a root when null)
   * and move `branch` to it. Answers the new commit's id.
   */
  commitFiles(repo: Repo, branch: string, files: Map<string, FlatFile>, message: string, parent: string | null): string {
    const tree = buildTreeFromFlat((type, data) => repo.put(type, data), files);
    const stamp = this.tick();
    const commit = buildCommit({
      tree,
      parents: parent ? [parent] : [],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: this.identity(),
      committer: this.identity(),
      timestamp: stamp.sec,
    });
    const oid = repo.put('commit', commit);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** Walk a branch's history, newest first: every ancestor commit, sorted for listing. */
  listCommits(repo: Repo, tip: string): Array<{ sha: string; message: string; author: string; committer: string; timestamp: number; parents: string[] }> {
    const ancestors = commitAncestors(repo.lookup, tip);
    const rows: Array<{ sha: string; message: string; author: string; committer: string; timestamp: number; parents: string[] }> = [];
    for (const sha of ancestors) {
      const object = repo.objects.get(sha);
      if (!object || object.type !== 'commit') continue;
      const parsed = parseCommit(object.data);
      rows.push({ sha, message: parsed.message, author: parsed.author, committer: parsed.committer, timestamp: parsed.timestamp, parents: parsed.parents });
    }
    rows.sort((a, b) => {
      if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
      return (repo.objectSeq.get(b.sha) ?? 0) - (repo.objectSeq.get(a.sha) ?? 0);
    });
    // A child must never sort after its parent: repair any inversion the
    // timestamps left (two commits can share a second) with a stable pass.
    const position = new Map(rows.map((row, index) => [row.sha, index]));
    let moved = true;
    let guard = 0;
    while (moved && guard < 8) {
      moved = false;
      guard += 1;
      for (const row of rows) {
        for (const parent of row.parents) {
          const parentPos = position.get(parent);
          const rowPos = position.get(row.sha)!;
          if (parentPos !== undefined && parentPos < rowPos) {
            rows.splice(rowPos, 1);
            rows.splice(parentPos, 0, row);
            rows.forEach((entry, index) => position.set(entry.sha, index));
            moved = true;
          }
        }
      }
    }
    return rows;
  }

  // -------------------------------------------------------------------------------------------
  // contents API over the git store
  // -------------------------------------------------------------------------------------------

  /** Read a path on a ref (branch name or commit id): a file's bytes and blob id, or a directory listing. */
  readContents(repo: Repo, refName: string, path: string):
    | { kind: 'file'; blob: string; data: Buffer }
    | { kind: 'dir'; entries: Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string; size: number | null }> }
    | null {
    const commitOid = this.resolveRef(repo, refName);
    if (!commitOid) return null;
    const files = repo.commitFiles(commitOid);
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (clean !== '') {
      const file = files.get(clean);
      if (file) {
        const object = repo.objects.get(file.oid);
        if (!object) return null;
        return { kind: 'file', blob: file.oid, data: object.data };
      }
    }
    // A directory: the entries directly under the prefix.
    const prefix = clean === '' ? '' : `${clean}/`;
    const entries = new Map<string, { name: string; path: string; type: 'file' | 'dir'; sha: string; size: number | null }>();
    for (const [filePath, file] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        const object = repo.objects.get(file.oid);
        entries.set(rest, { name: rest, path: filePath, type: 'file', sha: file.oid, size: object ? object.data.length : 0 });
      } else {
        const dirName = rest.slice(0, slash);
        if (!entries.has(dirName)) {
          entries.set(dirName, { name: dirName, path: `${prefix}${dirName}`, type: 'dir', sha: this.subtreeOid(repo, repo.commitTree(commitOid), `${prefix}${dirName}`), size: null });
        }
      }
    }
    if (clean !== '' && entries.size === 0) return null;
    return { kind: 'dir', entries: [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
  }

  /** The tree id of a directory inside a tree, for directory listings' sha fields. */
  private subtreeOid(repo: Repo, rootTree: string, dirPath: string): string {
    let current = rootTree;
    for (const segment of dirPath.split('/')) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return ZERO_OID;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (!entry) return ZERO_OID;
      current = entry.oid;
    }
    return current;
  }

  /** Resolve a ref name (branch, tag or commit id) to a commit id; null when unknown. */
  resolveRef(repo: Repo, refName: string): string | null {
    if (refName === 'HEAD') {
      const tip = repo.branchTip(repo.defaultBranch);
      return tip ? peelToCommit(repo.lookup, tip) : null;
    }
    const branchTip = repo.branchTip(refName);
    if (branchTip) return peelToCommit(repo.lookup, branchTip);
    const refTip = repo.refs.get(refName) ?? repo.refs.get(`refs/tags/${refName}`) ?? repo.refs.get(`refs/heads/${refName}`);
    if (refTip) return peelToCommit(repo.lookup, refTip);
    if (isObjectId(refName)) {
      const object = repo.objects.get(refName);
      if (object && object.type === 'commit') return refName;
      if (object && object.type === 'tag') return peelToCommit(repo.lookup, refName);
    }
    return null;
  }

  /**
   * Write a file through the contents API: creates the branch's next commit.
   * Enforces the optimistic-concurrency sha (409 on a stale one), creates an
   * unborn branch's first commit, and creates a missing branch from the
   * default branch when one is named (the MCP setup's fallback path).
   * Answers the commit id, the blob id, and whether the file is new.
   */
  putContents(repo: Repo, fields: { path: string; content: Buffer; message: string; branch?: string; sha?: string }): { commit: string; blob: string; created: boolean } {
    const branch = fields.branch && fields.branch !== '' ? fields.branch : repo.defaultBranch;
    let tip = repo.branchTip(branch);
    if (!tip && fields.branch && branch !== repo.defaultBranch) {
      // A contents write naming a branch that does not exist yet starts it
      // from the default branch's tip (or unborn, like the default).
      tip = repo.branchTip(repo.defaultBranch);
    }
    const files = tip ? repo.commitFiles(peelToCommit(repo.lookup, tip) ?? tip) : new Map<string, FlatFile>();
    const clean = fields.path.replace(/^\/+/, '');
    const existing = files.get(clean);
    if (existing && fields.sha !== undefined && fields.sha !== existing.oid) {
      throw new ForgeError(409, `${clean} has changed since ${fields.sha}`);
    }
    if (existing && existing.oid === hashObject('blob', fields.content)) {
      // No change: still a commit on GitHub, but the blob id is what it was.
    }
    const blob = repo.put('blob', fields.content);
    files.set(clean, { oid: blob, mode: existing?.mode ?? '100644' });
    const parentCommit = tip ? peelToCommit(repo.lookup, tip) : null;
    const commit = this.commitFiles(repo, branch, files, fields.message, parentCommit);
    return { commit, blob, created: !existing };
  }

  /** Delete a file through the contents API; answers the new commit id. */
  deleteContents(repo: Repo, fields: { path: string; message: string; branch?: string; sha?: string }): { commit: string } {
    const branch = fields.branch && fields.branch !== '' ? fields.branch : repo.defaultBranch;
    const tip = repo.branchTip(branch);
    if (!tip) throw new ForgeError(404, 'Not Found');
    const files = repo.commitFiles(peelToCommit(repo.lookup, tip) ?? tip);
    const clean = fields.path.replace(/^\/+/, '');
    const existing = files.get(clean);
    if (!existing) throw new ForgeError(404, 'Not Found');
    if (fields.sha !== undefined && fields.sha !== existing.oid) {
      throw new ForgeError(409, `${clean} has changed since ${fields.sha}`);
    }
    files.delete(clean);
    const commit = this.commitFiles(repo, branch, files, fields.message, peelToCommit(repo.lookup, tip));
    return { commit };
  }

  // -------------------------------------------------------------------------------------------
  // labels, issues, comments
  // -------------------------------------------------------------------------------------------

  /** Create a label; 422 when the name is taken. */
  createLabel(repo: Repo, name: string, color: string): Label {
    if (repo.labels.has(name)) throw new ForgeError(422, 'Label already exists');
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  /** Create an issue; 422 when a named label does not exist on the repository. */
  createIssue(repo: Repo, fields: { title: string; body?: string | null; labels?: string[] }): Issue {
    for (const name of fields.labels ?? []) {
      if (!repo.labels.has(name)) throw new ForgeError(422, `Label "${name}" does not exist`);
    }
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title: fields.title,
      body: fields.body ?? null,
      state: 'open',
      labels: [...(fields.labels ?? [])],
      comments: [],
      seq: repo.nextNumber,
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  /** Add a comment to an issue or pull request by number; 404 when neither holds it. */
  addComment(repo: Repo, number: number, body: string): Comment {
    const subject = repo.issues.get(number) ?? repo.pulls.get(number);
    if (!subject) throw new ForgeError(404, 'Not Found');
    const comment: Comment = { id: repo.nextCommentId, body };
    repo.nextCommentId += 1;
    subject.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------------------------------------
  // pull requests and merging
  // -------------------------------------------------------------------------------------------

  /** Open a pull request between two branches of the repository. */
  createPull(repo: Repo, fields: { title: string; body?: string | null; head: string; base: string }): Pull {
    const head = fields.head.includes(':') ? fields.head.slice(fields.head.indexOf(':') + 1) : fields.head;
    const base = fields.base.includes(':') ? fields.base.slice(fields.base.indexOf(':') + 1) : fields.base;
    if (!repo.branchTip(head)) throw new ForgeError(422, `Head branch "${head}" does not exist`);
    if (!repo.branchTip(base)) throw new ForgeError(422, `Base branch "${base}" does not exist`);
    if (head === base) throw new ForgeError(422, 'Head and base branches are the same');
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.head === head && pull.base === base) {
        throw new ForgeError(422, `A pull request already exists for ${head} into ${base}`);
      }
    }
    const pull: Pull = {
      id: this.nextPullId,
      number: repo.nextNumber,
      title: fields.title,
      body: fields.body ?? null,
      head,
      base,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      comments: [],
      seq: repo.nextNumber,
    };
    this.nextPullId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The files changed between a pull request's base and head tips. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }> {
    const baseTip = repo.branchTip(pull.base);
    const headTip = repo.branchTip(pull.head);
    if (!baseTip || !headTip) return [];
    const baseFiles = repo.commitFiles(peelToCommit(repo.lookup, baseTip) ?? baseTip);
    const headFiles = repo.commitFiles(peelToCommit(repo.lookup, headTip) ?? headTip);
    const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const before = baseFiles.get(path);
      const after = headFiles.get(path);
      if (before && after && before.oid === after.oid) continue;
      const oldText = before ? (repo.objects.get(before.oid)?.data.toString('utf8') ?? '') : '';
      const newText = after ? (repo.objects.get(after.oid)?.data.toString('utf8') ?? '') : '';
      const counts = lineDiffCounts(oldText, newText);
      out.push({
        filename: path,
        status: !before ? 'added' : !after ? 'removed' : 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
    return out;
  }

  /** Whether a pull request would merge cleanly right now (its mergeable state). */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const attempt = this.tryMerge(repo, pull);
    return attempt.ok ? 'MERGEABLE' : 'CONFLICTING';
  }

  /**
   * Dry-run a merge of the pull's head into its base: the three-way tree
   * merge against the merge base. Answers the merged tree when it is clean.
   */
  private tryMerge(repo: Repo, pull: Pull): { ok: boolean; tree: string | null; baseTip: string; headTip: string } {
    const baseTip = repo.branchTip(pull.base);
    const headTip = repo.branchTip(pull.head);
    if (!baseTip || !headTip) return { ok: false, tree: null, baseTip: baseTip ?? '', headTip: headTip ?? '' };
    const baseCommit = peelToCommit(repo.lookup, baseTip) ?? baseTip;
    const headCommit = peelToCommit(repo.lookup, headTip) ?? headTip;
    const ancestor = mergeBase(repo.lookup, baseCommit, headCommit);
    if (!ancestor) return { ok: false, tree: null, baseTip, headTip };
    if (ancestor === headCommit) return { ok: false, tree: null, baseTip, headTip }; // nothing to merge
    const result = mergeTrees(
      repo.lookup,
      (type, data) => repo.put(type, data),
      repo.commitTree(ancestor),
      repo.commitTree(baseCommit),
      repo.commitTree(headCommit),
    );
    return { ok: result.ok, tree: result.tree, baseTip, headTip };
  }

  /**
   * Merge a pull request. `method` is 'squash' or 'merge'. Throws 404 for an
   * unknown number (the caller checks first), 405 for a conflict or an
   * already-closed pull. Answers the merge commit's id.
   */
  mergePull(repo: Repo, pull: Pull, method: 'squash' | 'merge'): string {
    if (pull.state !== 'open' || pull.merged) throw new ForgeError(405, 'Pull Request is not open');
    const attempt = this.tryMerge(repo, pull);
    if (!attempt.ok || !attempt.tree) throw new ForgeError(405, 'Pull Request is not mergeable');
    const baseCommit = peelToCommit(repo.lookup, attempt.baseTip) ?? attempt.baseTip;
    const headCommit = peelToCommit(repo.lookup, attempt.headTip) ?? attempt.headTip;
    const stamp = this.tick();
    const message = method === 'squash' ? `${pull.title} (#${pull.number})\n` : `Merge pull request #${pull.number} from ${pull.head}\n`;
    const parents = method === 'squash' ? [baseCommit] : [baseCommit, headCommit];
    const commit = buildCommit({
      tree: attempt.tree,
      parents,
      message,
      author: this.identity(),
      committer: this.identity(),
      timestamp: stamp.sec,
    });
    const oid = repo.put('commit', commit);
    repo.refs.set(`refs/heads/${pull.base}`, oid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = stamp.iso;
    pull.mergeCommitSha = oid;
    return oid;
  }

  // -------------------------------------------------------------------------------------------
  // git wire support: pushes and fetches over the object store
  // -------------------------------------------------------------------------------------------

  /**
   * Absorb a received packfile into the repository's store. Throws GitError
   * (the receive-pack `unpack` line carries it) on a malformed pack.
   */
  absorbPack(repo: Repo, pack: Buffer): void {
    if (pack.length === 0) return;
    const objects = readPack(pack, repo.lookup);
    for (const [oid, object] of objects) repo.putKnown(oid, object);
  }

  /**
   * Validate and apply one receive-pack command against the current refs.
   * Answers null when the update was applied, or the refusal reason (the
   * `ng` line's tail) when it was not. Only fast-forwards are applied.
   */
  applyRefUpdate(repo: Repo, ref: string, oldOid: string, newOid: string): string | null {
    const current = repo.refs.get(ref) ?? ZERO_OID;
    if (oldOid !== current) {
      return oldOid === ZERO_OID ? 'reference already exists' : 'stale info';
    }
    if (newOid === ZERO_OID) {
      if (current === ZERO_OID) return 'reference does not exist';
      repo.refs.delete(ref);
      return null;
    }
    const object = repo.objects.get(newOid);
    if (!object) return 'invalid object';
    if (current !== ZERO_OID) {
      const newCommit = peelToCommit(repo.lookup, newOid);
      const oldCommit = peelToCommit(repo.lookup, current);
      if (!newCommit || !oldCommit) return 'invalid object';
      if (!isAncestor(repo.lookup, oldCommit, newCommit)) return 'non-fast-forward';
    }
    repo.refs.set(ref, newOid);
    return null;
  }

  /**
   * Compute the pack a fetch answers: the objects the client lacks, honouring
   * haves and the shallow rules. Also answers the shallow boundary lines the
   * response must carry (newly shallow and unshallowed commits).
   */
  fetchPack(repo: Repo, request: { wants: string[]; haves: string[]; shallow: string[]; depth: number | null }): { pack: Buffer; shallow: string[]; unshallow: string[] } {
    const lookup = repo.lookup;
    const clientShallow = new Set(request.shallow.filter((oid) => isObjectId(oid)));
    // What the client already holds: the closure of its haves, stopping at
    // the shallow boundary it declares (it does not hold those ancestors).
    const held = new Set<string>();
    {
      const queue: string[] = [];
      for (const have of request.haves) if (isObjectId(have)) queue.push(have);
      while (queue.length) {
        const oid = queue.pop()!;
        if (held.has(oid)) continue;
        const object = lookup(oid);
        if (!object) continue;
        held.add(oid);
        if (object.type === 'commit') {
          const commit = parseCommit(object.data);
          queue.push(commit.tree);
          if (!clientShallow.has(oid)) for (const parent of commit.parents) queue.push(parent);
        } else if (object.type === 'tag') {
          queue.push(peelTag(lookup, oid) === oid ? oid : parseTagTarget(object.data));
        } else if (object.type === 'tree') {
          for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
    // The commit set to send: breadth-first from the wants' commits, depth
    // counted in generations (a want is generation 1). Without a depth, a
    // declared shallow commit is a barrier; with one, depth alone decides.
    const wantCommits: string[] = [];
    for (const want of request.wants) {
      const commit = peelToCommit(lookup, want);
      if (commit) wantCommits.push(commit);
    }
    const distance = new Map<string, number>();
    const queue: string[] = [];
    for (const commit of wantCommits) {
      if (!distance.has(commit)) {
        distance.set(commit, 1);
        queue.push(commit);
      }
    }
    while (queue.length) {
      const oid = queue.shift()!;
      const depthHere = distance.get(oid)!;
      if (request.depth !== null && depthHere >= request.depth) continue;
      if (request.depth === null && clientShallow.has(oid)) continue;
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!distance.has(parent) && lookup(parent)) {
          distance.set(parent, depthHere + 1);
          queue.push(parent);
        }
      }
    }
    const includedCommits = new Set<string>();
    for (const [oid, depthHere] of distance) {
      if (request.depth !== null && depthHere > request.depth) continue;
      includedCommits.add(oid);
    }
    // The object set: tag objects the wants name, the included commits, and
    // their trees and blobs — minus everything the client already holds.
    const included = new Set<string>();
    for (const want of request.wants) {
      let current = want;
      for (let guard = 0; guard < 32; guard += 1) {
        const object = lookup(current);
        if (!object || object.type !== 'tag') break;
        included.add(current);
        current = parseTagTarget(object.data);
      }
    }
    for (const commit of includedCommits) {
      included.add(commit);
      const tree = repo.commitTree(commit);
      for (const oid of collectReachable([tree], lookup)) included.add(oid);
    }
    const send: GitObject[] = [];
    const sendIds: string[] = [];
    for (const oid of included) {
      if (held.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      send.push(object);
      sendIds.push(oid);
    }
    // The shallow bookkeeping the response reports: commits at the cut whose
    // parents stayed behind are newly shallow; declared-shallow commits that
    // gained their parents are unshallowed. Only meaningful when the fetch
    // is shallow-shaped at all.
    const shallow: string[] = [];
    const unshallow: string[] = [];
    if (request.depth !== null || clientShallow.size > 0) {
      for (const commit of includedCommits) {
        if (held.has(commit) && !request.wants.includes(commit)) continue;
        const object = lookup(commit);
        if (!object || object.type !== 'commit') continue;
        const parents = parseCommit(object.data).parents;
        const cut = parents.some((parent) => lookup(parent) && !includedCommits.has(parent) && !held.has(parent));
        const cutByHeld = parents.some((parent) => lookup(parent) && !includedCommits.has(parent));
        if ((cut || (request.depth !== null && cutByHeld && !clientShallow.has(commit))) && parents.length > 0) {
          if (!clientShallow.has(commit)) shallow.push(commit);
        } else if (clientShallow.has(commit)) {
          unshallow.push(commit);
        }
      }
    }
    sendIds.sort();
    const cacheKey = `${repo.id}:${sendIds.join(',')}`;
    let pack = this.packCache.get(cacheKey);
    if (!pack) {
      pack = writePack(send);
      if (this.packCache.size > 64) this.packCache.clear();
      this.packCache.set(cacheKey, pack);
    }
    return { pack, shallow: shallow.sort(), unshallow: unshallow.sort() };
  }
}

/** The target of a tag object's bytes (a tiny local read to keep forge.ts readable). */
function parseTagTarget(data: Buffer): string {
  const firstLine = data.subarray(0, data.indexOf('\n')).toString('utf8');
  return firstLine.startsWith('object ') ? firstLine.slice('object '.length).trim() : '';
}
