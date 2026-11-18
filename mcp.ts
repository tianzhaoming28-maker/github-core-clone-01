// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP at POST /mcp,
// speaking the 2026-07-28 revision (server/discover, no handshake, no
// session) and answering the legacy initialize handshake for older clients.
// The six tools github-mcp-server's surface needs — create_repo, get_repo,
// create_issue, list_issues, create_pull_request, merge_pull_request — act
// on the same forge store as REST and GraphQL, so an object made over MCP
// is the same object everywhere else.
//
// Wire discipline the suite checks: a body that is not JSON is an HTTP 400
// with a -32700 parse error; an unknown tool is -32602; a tools/call missing
// a required argument is -32602; two tools/list calls answer byte-identical
// lists (the tool table below is a constant); no Authorization header is an
// HTTP 401 before anything else happens.

import { ForgeError, type Forge } from './forge.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

/** An MCP answer: an HTTP status and a JSON body (null for a body-less 202). */
export interface McpResponse {
  readonly status: number;
  readonly body: unknown;
}

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** One tool's definition, exactly as tools/list answers it (a constant, so two calls agree byte for byte). */
interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { type: string; description: string }>>;
    readonly required: readonly string[];
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List a repository’s issues, optionally filtered by state (open, closed or all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all (default open).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) and mark it merged.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** A JSON-RPC error answer. */
function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** A JSON-RPC result answer. */
function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/** A tool result: the value as a JSON text block and as structured content. */
function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

/** A tool execution failure (the tool ran and refused), as isError content. */
function toolFailure(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** Read a string argument, or ''. */
function argStr(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

/** Run one tool against the forge; throws ForgeError for refusals the caller turns into isError. */
function runTool(forge: Forge, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'create_repo': {
      const repo = forge.createRepo({
        name: argStr(args, 'name'),
        description: argStr(args, 'description'),
        private: args.private === true,
      });
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = forge.mustRepo(argStr(args, 'owner'), argStr(args, 'repo'));
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = forge.mustRepo(argStr(args, 'owner'), argStr(args, 'repo'));
      const issue = forge.createIssue(repo, {
        title: argStr(args, 'title'),
        body: typeof args.body === 'string' ? args.body : null,
      });
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = forge.mustRepo(argStr(args, 'owner'), argStr(args, 'repo'));
      const state = argStr(args, 'state') || 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      return toolResult(list.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = forge.mustRepo(argStr(args, 'owner'), argStr(args, 'repo'));
      const pull = forge.createPull(repo, {
        title: argStr(args, 'title'),
        body: typeof args.body === 'string' ? args.body : null,
        head: argStr(args, 'head'),
        base: argStr(args, 'base') || repo.defaultBranch,
      });
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = forge.mustRepo(argStr(args, 'owner'), argStr(args, 'repo'));
      const raw = args.pull_number;
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (!pull) throw new ForgeError(404, 'Pull request not found');
      forge.mergePull(repo, pull, 'squash');
      return toolResult(pullJson(repo, pull));
    }
    default:
      return null;
  }
}

/** Handle one JSON-RPC request object; null when it is a notification (no answer is owed). */
function handleRequest(forge: Forge, request: Record<string, unknown>): Record<string, unknown> | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params && typeof request.params === 'object' ? request.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = (SUPPORTED_VERSIONS as readonly string[]).includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === toolName);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      for (const required of tool.inputSchema.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return rpcError(id, -32602, `Missing required argument: ${required}`);
        }
      }
      try {
        const result = runTool(forge, toolName, args);
        return rpcResult(id, result);
      } catch (err) {
        if (err instanceof ForgeError) return rpcResult(id, toolFailure(err.message));
        throw err;
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * Handle one POST /mcp body (already authenticated by the caller). A body
 * that is not JSON is the transport's parse error: HTTP 400 with -32700.
 * Notifications answer 202 with no body.
 */
export function handleMcp(forge: Forge, rawBody: string): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    const answers: unknown[] = [];
    for (const entry of parsed) {
      if (entry && typeof entry === 'object') {
        const answer = handleRequest(forge, entry as Record<string, unknown>);
        if (answer !== null) answers.push(answer);
      }
    }
    return { status: 200, body: answers };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { status: 400, body: rpcError(null, -32600, 'Invalid request') };
  }
  const answer = handleRequest(forge, parsed as Record<string, unknown>);
  if (answer === null) return { status: 202, body: null };
  return { status: 200, body: answer };
}
