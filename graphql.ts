// The GraphQL v4 surface: a small lexer, parser and executor for the
// documents gh and github-mcp-server actually send — viewer, repository
// fields, issue and pull-request reads, the create/close/merge mutations,
// node(id:), introspection of the types those clients feature-detect, cursor
// pagination, operation batching, and field validation that answers a 200
// with an errors array naming the bad field, as GitHub does.
//
// Global ids are opaque and stable: base64url of `v1:<Type>:<key>`, where the
// key is the repository's database id, or `<repoDbId>:<number>` (plus a
// comment id for comments). They round-trip through node(id:) and the
// mutation inputs, and they are never the plain database id.

import { ForgeError, type Forge, type Issue, type Pull, type Repo } from './forge.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type Token =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'punct'; readonly value: string }
  | { readonly kind: 'spread' }
  | { readonly kind: 'eof' };

/** Tokenise a GraphQL document. Throws on a character the grammar has no use for. */
function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:@$=!|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      const text = source.slice(i, j);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new Error(`bad number ${text}`);
      tokens.push(text.includes('.') || text.includes('e') || text.includes('E') ? { kind: 'float', value } : { kind: 'int', value });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// AST and parser
// ---------------------------------------------------------------------------------------------

/** A value in a document: a literal, a list, an object, or a variable reference. */
export type Value =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly items: readonly Value[] }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, Value>> }
  | { readonly kind: 'variable'; readonly name: string };

export interface FieldNode {
  readonly kind: 'field';
  readonly name: string;
  readonly alias: string | null;
  readonly args: Readonly<Record<string, Value>>;
  readonly selection: readonly SelectionNode[] | null;
}

export type SelectionNode =
  | FieldNode
  | { readonly kind: 'inlineFragment'; readonly typeCondition: string | null; readonly selection: readonly SelectionNode[] }
  | { readonly kind: 'fragmentSpread'; readonly name: string };

export interface OperationNode {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly selection: readonly SelectionNode[];
}

export interface DocumentNode {
  readonly operations: readonly OperationNode[];
  readonly fragments: Readonly<Record<string, { typeCondition: string | null; selection: readonly SelectionNode[] }>>;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  /** Skip a type annotation (`String!`, `[IssueState!]`, ...) in variable definitions. */
  private skipType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.skipType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  private parseValue(): Value {
    const token = this.next();
    switch (token.kind) {
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: token.value };
      case 'float':
        return { kind: 'float', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.expectName() };
        if (token.value === '[') {
          const items: Value[] = [];
          while (!this.atPunct(']')) items.push(this.parseValue());
          this.expectPunct(']');
          return { kind: 'list', items };
        }
        if (token.value === '{') {
          const fields: Record<string, Value> = {};
          while (!this.atPunct('}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields[name] = this.parseValue();
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected ${token.value} in a value`);
      default:
        throw new Error('unexpected token in a value');
    }
  }

  private parseArguments(): Record<string, Value> {
    const args: Record<string, Value> = {};
    if (!this.atPunct('(')) return args;
    this.next();
    while (!this.atPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  /** Skip directives (`@include(if: ...)`) — the documents sent here carry none that matter. */
  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.expectName();
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      throw new Error('bad fragment');
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    const selection = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, selection };
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments: Record<string, { typeCondition: string | null; selection: readonly SelectionNode[] }> = {};
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation');
      if (token.value === 'query' || token.value === 'mutation') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.atPunct('(')) {
          this.next();
          while (!this.atPunct(')')) {
            this.expectPunct('$');
            this.expectName();
            this.expectPunct(':');
            this.skipType();
            if (this.atPunct('=')) {
              this.next();
              this.parseValue();
            }
            this.skipDirectives();
          }
          this.expectPunct(')');
        }
        this.skipDirectives();
        operations.push({ type: token.value, name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected `on` in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments[fragName] = { typeCondition, selection: this.parseSelectionSet() };
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }
}

/** Parse a document; throws on a syntax error. */
export function parseGraphQL(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

/** Resolve a parsed Value against the operation's variables into plain JSON data. */
export function resolveValue(value: Value, variables: Readonly<Record<string, unknown>>): unknown {
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value.fields)) out[key] = resolveValue(field, variables);
      return out;
    }
    case 'variable':
      return variables[value.name];
  }
}

// ---------------------------------------------------------------------------------------------
// global ids
// ---------------------------------------------------------------------------------------------

/** Encode a global id: opaque, stable, and never the plain database id. */
export function globalId(type: string, key: string): string {
  return Buffer.from(`v1:${type}:${key}`, 'utf8').toString('base64url');
}

/** Decode a global id into its type and key; null when it is not one of ours. */
export function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    if (!text.startsWith('v1:')) return null;
    const rest = text.slice(3);
    const colon = rest.indexOf(':');
    if (colon < 0) return null;
    return { type: rest.slice(0, colon), key: rest.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// the schema: type -> field -> resolver. Resolvers receive (forge, source, args).
// ---------------------------------------------------------------------------------------------

/** The execution context every resolver shares. */
interface Ctx {
  readonly forge: Forge;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly document: DocumentNode;
  readonly errors: Array<{ message: string }>;
}

type Resolver = (ctx: Ctx, source: any, args: Record<string, unknown>) => unknown;

/** The static shape of one object type: its fields, for execution and introspection alike. */
interface TypeDef {
  readonly kind: 'OBJECT' | 'ENUM';
  readonly fields: Readonly<Record<string, Resolver>>;
  readonly enumValues?: readonly string[];
}

/** Wrap a value with the GraphQL type it should be executed as. */
interface Typed {
  readonly __type: string;
  readonly value: unknown;
}

function typed(type: string, value: unknown): Typed {
  return { __type: type, value };
}

/** A cursor for connection pagination: base64url of the last node's number. */
function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberOfCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const value = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** An issue as a GraphQL source value. */
function issueSource(repo: Repo, issue: Issue): { repo: Repo; issue: Issue } {
  return { repo, issue };
}

/** A pull request as a GraphQL source value. */
function pullSource(repo: Repo, pull: Pull): { repo: Repo; pull: Pull } {
  return { repo, pull };
}

const REPO_ID = (repo: Repo): string => globalId('Repository', String(repo.id));
const ISSUE_ID = (repo: Repo, issue: Issue): string => globalId('Issue', `${repo.id}:${issue.number}`);
const PULL_ID = (repo: Repo, pull: Pull): string => globalId('PullRequest', `${repo.id}:${pull.number}`);

/** Find a repository by its database id (mutation inputs and node(id:) carry it). */
function repoByDbId(forge: Forge, dbId: number): Repo | null {
  for (const repo of forge.listRepos()) if (repo.id === dbId) return repo;
  return null;
}

/** Find a repository by a global id; null when the id names no live repository. */
function repoByGlobalId(forge: Forge, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Repository') return null;
  return repoByDbId(forge, Number.parseInt(decoded.key, 10));
}

/** The connection answer for a page of issues. */
function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): Typed {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    list = list.filter((issue) => wanted.has(issue.state.toUpperCase()));
  }
  let descending = true;
  const orderBy = args.orderBy;
  if (orderBy && typeof orderBy === 'object') {
    const direction = (orderBy as Record<string, unknown>).direction;
    if (direction === 'ASC') descending = false;
  }
  list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const after = typeof args.after === 'string' ? numberOfCursor(args.after) : null;
  if (after !== null) {
    const index = list.findIndex((issue) => issue.number === after);
    if (index >= 0) list = list.slice(index + 1);
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  return typed('IssueConnection', {
    nodes: page.map((issue) => typed('Issue', issueSource(repo, issue))),
    pageInfo: {
      hasNextPage,
      endCursor: page.length > 0 ? cursorOf(page[page.length - 1].number) : null,
      startCursor: page.length > 0 ? cursorOf(page[0].number) : null,
    },
    totalCount: list.length,
  });
}

const SCHEMA: Readonly<Record<string, TypeDef>> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: (ctx) => typed('User', ctx.forge.viewer),
      repository: (ctx, _source, args) => {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const repo = ctx.forge.repo(owner, name);
        return repo ? typed('Repository', repo) : null;
      },
      node: (ctx, _source, args) => {
        const id = typeof args.id === 'string' ? args.id : '';
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.type === 'Repository') {
          const repo = repoByDbId(ctx.forge, Number.parseInt(decoded.key, 10));
          return repo ? typed('Repository', repo) : null;
        }
        if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
          const [repoId, number] = decoded.key.split(':').map((part) => Number.parseInt(part, 10));
          const repo = repoByDbId(ctx.forge, repoId);
          if (!repo) return null;
          if (decoded.type === 'Issue') {
            const issue = repo.issues.get(number);
            return issue ? typed('Issue', issueSource(repo, issue)) : null;
          }
          const pull = repo.pulls.get(number);
          return pull ? typed('PullRequest', pullSource(repo, pull)) : null;
        }
        return null;
      },
      __type: (_ctx, _source, args) => {
        const name = typeof args.name === 'string' ? args.name : '';
        const def = SCHEMA[name];
        if (!def) return null;
        return typed('__Type', { name, def });
      },
      __schema: () => typed('__Schema', {}),
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(ctx.forge, input.repositoryId) : null;
        if (!repo) throw new ForgeError(422, 'Repository not found');
        const issue = ctx.forge.createIssue(repo, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : null,
        });
        return typed('CreateIssuePayload', { issue: typed('Issue', issueSource(repo, issue)) });
      },
      closeIssue: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
        if (!decoded || decoded.type !== 'Issue') throw new ForgeError(422, 'Issue not found');
        const [repoId, number] = decoded.key.split(':').map((part) => Number.parseInt(part, 10));
        const repo = repoByDbId(ctx.forge, repoId);
        const issue = repo?.issues.get(number);
        if (!repo || !issue) throw new ForgeError(422, 'Issue not found');
        issue.state = 'closed';
        return typed('CloseIssuePayload', { issue: typed('Issue', issueSource(repo, issue)) });
      },
      createPullRequest: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(ctx.forge, input.repositoryId) : null;
        if (!repo) throw new ForgeError(422, 'Repository not found');
        const pull = ctx.forge.createPull(repo, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : null,
          head: typeof input.headRefName === 'string' ? input.headRefName : '',
          base: typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch,
        });
        return typed('CreatePullRequestPayload', { pullRequest: typed('PullRequest', pullSource(repo, pull)) });
      },
      mergePullRequest: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
        if (!decoded || decoded.type !== 'PullRequest') throw new ForgeError(422, 'Pull request not found');
        const [repoId, number] = decoded.key.split(':').map((part) => Number.parseInt(part, 10));
        const repo = repoByDbId(ctx.forge, repoId);
        const pull = repo?.pulls.get(number);
        if (!repo || !pull) throw new ForgeError(422, 'Pull request not found');
        const method = input.mergeMethod === 'MERGE' ? 'merge' : 'squash';
        ctx.forge.mergePull(repo, pull, method);
        return typed('MergePullRequestPayload', { pullRequest: typed('PullRequest', pullSource(repo, pull)) });
      },
      addComment: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
        if (!decoded || (decoded.type !== 'Issue' && decoded.type !== 'PullRequest')) throw new ForgeError(422, 'Subject not found');
        const [repoId, number] = decoded.key.split(':').map((part) => Number.parseInt(part, 10));
        const repo = repoByDbId(ctx.forge, repoId);
        if (!repo) throw new ForgeError(422, 'Subject not found');
        const comment = ctx.forge.addComment(repo, number, typeof input.body === 'string' ? input.body : '');
        return typed('AddCommentPayload', {
          commentEdge: typed('IssueCommentEdge', {
            node: typed('IssueComment', { id: globalId('IssueComment', `${repo.id}:${number}:${comment.id}`), body: comment.body }),
          }),
        });
      },
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      login: (_ctx, user) => (user as { login: string }).login,
      id: (_ctx, user) => globalId('User', String((user as { id: number }).id)),
      name: (_ctx, user) => (user as { name: string }).name,
      email: (_ctx, user) => (user as { email: string }).email,
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: (_ctx, repo) => REPO_ID(repo as Repo),
      databaseId: (_ctx, repo) => (repo as Repo).id,
      name: (_ctx, repo) => (repo as Repo).name,
      nameWithOwner: (_ctx, repo) => `${(repo as Repo).owner}/${(repo as Repo).name}`,
      owner: (_ctx, repo) => typed('User', { login: (repo as Repo).owner, id: 1000, name: (repo as Repo).owner, email: '' }),
      description: (_ctx, repo) => (repo as Repo).description,
      isPrivate: (_ctx, repo) => (repo as Repo).isPrivate,
      defaultBranchRef: (_ctx, repo) => {
        const r = repo as Repo;
        const tip = r.branchTip(r.defaultBranch);
        return tip ? typed('Ref', { name: r.defaultBranch, target: { oid: tip } }) : null;
      },
      viewerPermission: () => 'ADMIN',
      hasIssuesEnabled: () => true,
      hasPullRequestsEnabled: () => true,
      issue: (_ctx, repo, args) => {
        const r = repo as Repo;
        const issue = typeof args.number === 'number' ? r.issues.get(args.number) : undefined;
        return issue ? typed('Issue', issueSource(r, issue)) : null;
      },
      issues: (ctx, repo, args) => issuesConnection(ctx, repo as Repo, args),
      pullRequest: (_ctx, repo, args) => {
        const r = repo as Repo;
        const pull = typeof args.number === 'number' ? r.pulls.get(args.number) : undefined;
        return pull ? typed('PullRequest', pullSource(r, pull)) : null;
      },
      pullRequests: (_ctx, repo, args) => {
        const r = repo as Repo;
        let list = [...r.pulls.values()].sort((a, b) => a.number - b.number);
        const states = args.states;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state).toUpperCase()));
          list = list.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
        }
        const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : list.length;
        return typed('PullRequestConnection', { nodes: list.slice(0, first).map((pull) => typed('PullRequest', pullSource(r, pull))), totalCount: list.length });
      },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: (_ctx, source) => ISSUE_ID((source as { repo: Repo }).repo, (source as { issue: Issue }).issue),
      databaseId: (_ctx, source) => (source as { issue: Issue }).issue.id,
      number: (_ctx, source) => (source as { issue: Issue }).issue.number,
      title: (_ctx, source) => (source as { issue: Issue }).issue.title,
      body: (_ctx, source) => (source as { issue: Issue }).issue.body,
      state: (_ctx, source) => ((source as { issue: Issue }).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
      author: (ctx, source) => typed('User', ctx.forge.viewer),
      repository: (_ctx, source) => typed('Repository', (source as { repo: Repo }).repo),
      labels: (_ctx, source) => {
        const { repo, issue } = source as { repo: Repo; issue: Issue };
        return typed('LabelConnection', { nodes: issue.labels.map((name) => typed('Label', { name, color: repo.labels.get(name)?.color ?? 'ededed' })) });
      },
      comments: (_ctx, source) => {
        const { repo, issue } = source as { repo: Repo; issue: Issue };
        return typed('IssueCommentConnection', {
          nodes: issue.comments.map((comment) => typed('IssueComment', { id: globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`), body: comment.body })),
          totalCount: issue.comments.length,
        });
      },
      createdAt: (_ctx, source) => new Date(1_700_000_000_000 + (source as { issue: Issue }).issue.number * 1000).toISOString(),
      updatedAt: (_ctx, source) => new Date(1_700_000_000_000 + (source as { issue: Issue }).issue.number * 1000).toISOString(),
      url: (_ctx, source) => `https://forge.invalid/issues/${(source as { issue: Issue }).issue.number}`,
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: (_ctx, source) => PULL_ID((source as { repo: Repo }).repo, (source as { pull: Pull }).pull),
      databaseId: (_ctx, source) => (source as { pull: Pull }).pull.id,
      number: (_ctx, source) => (source as { pull: Pull }).pull.number,
      title: (_ctx, source) => (source as { pull: Pull }).pull.title,
      body: (_ctx, source) => (source as { pull: Pull }).pull.body,
      state: (_ctx, source) => {
        const pull = (source as { pull: Pull }).pull;
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      },
      merged: (_ctx, source) => (source as { pull: Pull }).pull.merged,
      mergedAt: (_ctx, source) => (source as { pull: Pull }).pull.mergedAt,
      mergeCommit: (_ctx, source) => {
        const pull = (source as { pull: Pull }).pull;
        return pull.mergeCommitSha ? typed('Commit', { oid: pull.mergeCommitSha }) : null;
      },
      headRefName: (_ctx, source) => (source as { pull: Pull }).pull.head,
      baseRefName: (_ctx, source) => (source as { pull: Pull }).pull.base,
      headRef: (_ctx, source) => {
        const { repo, pull } = source as { repo: Repo; pull: Pull };
        const tip = repo.branchTip(pull.head);
        return tip ? typed('Ref', { name: pull.head, target: { oid: tip } }) : null;
      },
      baseRef: (_ctx, source) => {
        const { repo, pull } = source as { repo: Repo; pull: Pull };
        const tip = repo.branchTip(pull.base);
        return tip ? typed('Ref', { name: pull.base, target: { oid: tip } }) : null;
      },
      mergeable: (ctx, source) => {
        const { repo, pull } = source as { repo: Repo; pull: Pull };
        return ctx.forge.pullMergeable(repo, pull);
      },
      author: (ctx) => typed('User', ctx.forge.viewer),
      repository: (_ctx, source) => typed('Repository', (source as { repo: Repo }).repo),
      files: (ctx, source, args) => {
        const { repo, pull } = source as { repo: Repo; pull: Pull };
        // Computed against the refs' current tips, as the REST files view is.
        const files = ctx.forge.pullFiles(repo, pull);
        const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : files.length;
        return typed('PullRequestChangedFileConnection', {
          nodes: files.slice(0, first).map((file) => typed('PullRequestChangedFile', file)),
          totalCount: files.length,
        });
      },
      createdAt: (_ctx, source) => new Date(1_700_000_000_000 + (source as { pull: Pull }).pull.number * 1000).toISOString(),
      updatedAt: (_ctx, source) => new Date(1_700_000_000_000 + (source as { pull: Pull }).pull.number * 1000).toISOString(),
      url: (_ctx, source) => `https://forge.invalid/pull/${(source as { pull: Pull }).pull.number}`,
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: (_ctx, source) => (source as { name: string }).name,
      prefix: () => 'refs/heads/',
      target: (_ctx, source) => typed('Commit', (source as { target: { oid: string } }).target),
    },
  },
  Commit: {
    kind: 'OBJECT',
    fields: {
      oid: (_ctx, source) => (source as { oid: string }).oid,
      id: (_ctx, source) => globalId('Commit', (source as { oid: string }).oid),
    },
  },
  Label: {
    kind: 'OBJECT',
    fields: {
      name: (_ctx, source) => (source as { name: string }).name,
      color: (_ctx, source) => (source as { color: string }).color,
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: (_ctx, source) => (source as { id: string }).id,
      body: (_ctx, source) => (source as { body: string }).body,
      author: (ctx) => typed('User', ctx.forge.viewer),
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: (_ctx, source) => (source as { nodes: unknown }).nodes,
      pageInfo: (_ctx, source) => typed('PageInfo', (source as { pageInfo: unknown }).pageInfo),
      totalCount: (_ctx, source) => (source as { totalCount: number }).totalCount,
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: (_ctx, source) => (source as { nodes: unknown }).nodes,
      pageInfo: (_ctx, source) => typed('PageInfo', (source as { pageInfo?: unknown }).pageInfo ?? { hasNextPage: false, endCursor: null, startCursor: null }),
      totalCount: (_ctx, source) => (source as { totalCount: number }).totalCount,
    },
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: (_ctx, source) => (source as { nodes: unknown }).nodes,
      totalCount: (_ctx, source) => (source as { totalCount: number }).totalCount,
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: (_ctx, source) => (source as { filename: string }).filename,
      additions: (_ctx, source) => (source as { additions: number }).additions,
      deletions: (_ctx, source) => (source as { deletions: number }).deletions,
      changeType: (_ctx, source) => {
        const status = (source as { status: string }).status;
        return status === 'added' ? 'ADDED' : status === 'removed' ? 'DELETED' : 'MODIFIED';
      },
    },
  },
  LabelConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: (_ctx, source) => (source as { nodes: unknown }).nodes,
    },
  },
  IssueCommentConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: (_ctx, source) => (source as { nodes: unknown }).nodes,
      totalCount: (_ctx, source) => (source as { totalCount: number }).totalCount,
    },
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: {
      node: (_ctx, source) => (source as { node: unknown }).node,
      cursor: () => cursorOf(0),
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: (_ctx, source) => (source as { hasNextPage: boolean }).hasNextPage,
      hasPreviousPage: () => false,
      endCursor: (_ctx, source) => (source as { endCursor: string | null }).endCursor,
      startCursor: (_ctx, source) => (source as { startCursor: string | null }).startCursor,
    },
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: { issue: (_ctx, source) => (source as { issue: unknown }).issue, clientMutationId: () => null },
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: { issue: (_ctx, source) => (source as { issue: unknown }).issue, clientMutationId: () => null },
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: (_ctx, source) => (source as { pullRequest: unknown }).pullRequest, clientMutationId: () => null },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: (_ctx, source) => (source as { pullRequest: unknown }).pullRequest, clientMutationId: () => null },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: { commentEdge: (_ctx, source) => (source as { commentEdge: unknown }).commentEdge, clientMutationId: () => null },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: (_ctx, source) => (source as { name: string }).name,
      kind: (_ctx, source) => ((source as { def: TypeDef }).def.kind === 'ENUM' ? 'ENUM' : 'OBJECT'),
      description: () => null,
      fields: (_ctx, source) => {
        const def = (source as { def: TypeDef }).def;
        if (def.kind === 'ENUM') return null;
        return Object.keys(def.fields).map((name) => typed('__Field', { name }));
      },
      enumValues: (_ctx, source) => {
        const def = (source as { def: TypeDef }).def;
        if (def.kind !== 'ENUM') return null;
        return (def.enumValues ?? []).map((name) => typed('__EnumValue', { name }));
      },
      possibleTypes: () => null,
      inputFields: () => null,
      ofType: () => null,
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: (_ctx, source) => (source as { name: string }).name,
      description: () => null,
      isDeprecated: () => false,
      deprecationReason: () => null,
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: (_ctx, source) => (source as { name: string }).name,
      description: () => null,
      isDeprecated: () => false,
      deprecationReason: () => null,
    },
  },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      queryType: () => typed('__Type', { name: 'Query', def: SCHEMA.Query }),
      mutationType: () => typed('__Type', { name: 'Mutation', def: SCHEMA.Mutation }),
    },
  },
  IssueState: { kind: 'ENUM', fields: {}, enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: {}, enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: {}, enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', fields: {}, enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', fields: {}, enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', fields: {}, enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueOrderField: { kind: 'ENUM', fields: {}, enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', fields: {}, enumValues: ['ASC', 'DESC'] },
};

// ---------------------------------------------------------------------------------------------
// validation and execution
// ---------------------------------------------------------------------------------------------

/** Flatten a selection set through fragments into the fields it names. */
function flattenSelections(ctx: Ctx, selections: readonly SelectionNode[], typeName: string, out: FieldNode[]): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out.push(selection);
    } else if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) flattenSelections(ctx, selection.selection, typeName, out);
    } else {
      const fragment = ctx.document.fragments[selection.name];
      if (fragment && (fragment.typeCondition === null || fragment.typeCondition === typeName)) {
        flattenSelections(ctx, fragment.selection, typeName, out);
      }
    }
  }
}

/**
 * Execute one field's selection set against a typed source value. A field
 * the type does not hold is a validation error naming it (GitHub answers a
 * 200 with an errors array, not an HTTP error), and the rest still resolves.
 */
function executeSelectionSet(ctx: Ctx, typeName: string, source: unknown, selections: readonly SelectionNode[]): Record<string, unknown> {
  const def = SCHEMA[typeName];
  const out: Record<string, unknown> = {};
  const fields: FieldNode[] = [];
  flattenSelections(ctx, selections, typeName, fields);
  for (const field of fields) {
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = def?.fields[field.name];
    if (!resolver) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of Object.entries(field.args)) args[argName] = resolveValue(argValue, ctx.variables);
    let value: unknown;
    try {
      value = resolver(ctx, source, args);
    } catch (err) {
      if (err instanceof ForgeError) {
        ctx.errors.push({ message: err.message });
        out[key] = null;
        continue;
      }
      throw err;
    }
    out[key] = completeValue(ctx, value, field);
  }
  return out;
}

/** Complete a resolver's answer: recurse into typed values and lists, leave scalars alone. */
function completeValue(ctx: Ctx, value: unknown, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, field));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    const typedValue = value as Typed;
    if (!field.selection) return typedValue.value;
    return executeSelectionSet(ctx, typedValue.__type, typedValue.value, field.selection);
  }
  return value;
}

/** Execute one operation document against the forge. */
export function executeGraphQL(
  forge: Forge,
  document: DocumentNode,
  variables: Readonly<Record<string, unknown>>,
  operationName: string | null,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const ctx: Ctx = { forge, variables, document, errors: [] };
  let operation = document.operations[0];
  if (operationName) {
    operation = document.operations.find((candidate) => candidate.name === operationName) ?? operation;
  }
  if (!operation) return { data: null, errors: [{ message: 'No operation in the document' }] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, rootType, null, operation.selection);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}
