// The HTTP plumbing: one server that routes every surface the forge speaks
// — the health probe, REST v3, GraphQL v4, the MCP endpoint and the git
// smart-HTTP wire — and holds the wire discipline they share: JSON answers,
// a non-empty X-GitHub-Request-Id on every reply, bearer-token auth on
// everything but /healthz (no token is a 401 with a JSON message, a repo
// under another login is a 404, never a 403), and a JSON 404 for anything
// unknown, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './forge.ts';
import { routeRest } from './rest.ts';
import { executeGraphQL, parseGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body the forge reads (a push pack is the biggest thing on the wire). */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

/** The request-id counter: every reply carries one, unique and non-empty. */
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `F0RGE-${requestCounter.toString(16).toUpperCase().padStart(6, '0')}`;
}

/** Answer with a JSON body and the shared headers. */
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Readonly<Record<string, string>> = {}): void {
  const text = body === null || body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...(text === '' ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...extra,
  });
  res.end(text === '' ? undefined : text);
}

/** Answer with raw bytes (the git wire) and the shared request id. */
function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': body.length,
  });
  res.end(body);
}

/** Read a request's whole body. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Decode one path segment; a malformed escape is left as-is rather than throwing. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build the forge's HTTP server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  /** True when the request carries the trial's bearer token. */
  const authed = (req: IncomingMessage): boolean => {
    if (token === '') return true; // no token configured (local runs): the viewer is whoever asks
    return req.headers.authorization === `Bearer ${token}`;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://entry');
    } catch {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    const path = url.pathname;

    // The boot probe: no auth, always the same answer.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Everything else requires the token.
    if (!authed(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }

    // REST v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      const segments = path
        .slice('/api/v3'.length)
        .split('/')
        .filter((segment) => segment !== '')
        .map(decodeSegment);
      let body: Record<string, unknown> | undefined;
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        const raw = await readBody(req);
        if (raw.length > 0) {
          try {
            const parsed: unknown = JSON.parse(raw.toString('utf8'));
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
            body = parsed as Record<string, unknown>;
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
        }
      }
      const host = req.headers.host ?? 'entry';
      const answer = routeRest(forge, {
        method,
        segments,
        query: url.searchParams,
        body,
        baseUrl: `http://${host}`,
        path,
      });
      if (answer.status === 204) {
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      sendJson(res, answer.status, answer.body, answer.headers ?? {});
      return;
    }

    // GraphQL v4.
    if (path === '/api/graphql' && method === 'POST') {
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
        return;
      }
      const runOne = (entry: unknown): unknown => {
        if (!entry || typeof entry !== 'object') return { errors: [{ message: 'Invalid operation' }] };
        const operation = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
        if (typeof operation.query !== 'string') return { errors: [{ message: 'No query document' }] };
        try {
          const document = parseGraphQL(operation.query);
          const variables = (operation.variables && typeof operation.variables === 'object' ? operation.variables : {}) as Record<string, unknown>;
          return executeGraphQL(forge, document, variables, typeof operation.operationName === 'string' ? operation.operationName : null);
        } catch (err) {
          return { errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
        }
      };
      if (Array.isArray(parsed)) {
        sendJson(res, 200, parsed.map(runOne));
        return;
      }
      sendJson(res, 200, runOne(parsed));
      return;
    }

    // MCP.
    if (path === '/mcp' && method === 'POST') {
      const raw = await readBody(req);
      const answer = handleMcp(forge, raw.toString('utf8'));
      if (answer.status === 202) {
        res.writeHead(202, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      sendJson(res, answer.status, answer.body);
      return;
    }
    if (path === '/mcp') {
      // Streamable HTTP's optional server stream and session teardown: this
      // forge is stateless, so a GET has nothing to stream and a DELETE has
      // no session to end; both are legal no-ops for the client.
      if (method === 'DELETE') {
        res.writeHead(200, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch) {
      const owner = decodeSegment(gitMatch[1]);
      const name = decodeSegment(gitMatch[2]);
      const service = gitMatch[3];
      const repo = forge.repo(owner, name);
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const protocolHeader = req.headers['git-protocol'];
      const protocolV2 = typeof protocolHeader === 'string' && protocolHeader.includes('version=2');
      if (service === 'info/refs' && method === 'GET') {
        const serviceParam = url.searchParams.get('service') ?? '';
        const answer = infoRefs(repo, serviceParam, protocolV2);
        sendRaw(res, answer.status, answer.contentType, answer.body);
        return;
      }
      if (service === 'git-upload-pack' && method === 'POST') {
        const body = await readBody(req);
        const answer = uploadPack(forge, repo, body, protocolV2);
        sendRaw(res, answer.status, answer.contentType, answer.body);
        return;
      }
      if (service === 'git-receive-pack' && method === 'POST') {
        const body = await readBody(req);
        const answer = receivePack(forge, repo, body);
        sendRaw(res, answer.status, answer.contentType, answer.body);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // Anything else: GitHub's JSON 404.
    sendJson(res, 404, { message: 'Not Found' });
  };

  return createServer((req, res) => {
    handle(req, res).catch(() => {
      // A handler bug must never hang or kill the server: the suite's
      // survivability checks require it to keep answering afterwards.
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}
