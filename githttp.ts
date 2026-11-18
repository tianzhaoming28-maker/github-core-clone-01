// The git smart-HTTP surface: info/refs advertisements (protocol v2 and
// v0), the v2 ls-refs and fetch commands, a v0 fetch fallback, and v0
// receive-pack pushes with report-status. Repositories live under
// /{owner}/{repo}.git; a push cannot invent one, and a missing repository
// answers 404 on both services.

import type { Forge, Repo } from './forge.ts';
import {
  GitError,
  PKT_DELIM,
  PKT_FLUSH,
  decodePktLines,
  peelTag,
  pktLine,
  type PktPacket,
} from './gitstore.ts';

/** A git HTTP answer: a status, a content type and the raw body bytes. */
export interface GitResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** A JSON refusal (a missing repository, a malformed request). */
function jsonError(status: number, message: string): GitResponse {
  return { status, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

/** The refs a repository advertises, sorted by name, with peeled tag targets. */
function advertisedRefs(repo: Repo): Array<{ name: string; oid: string; peeled: string | null }> {
  const out: Array<{ name: string; oid: string; peeled: string | null }> = [];
  for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    let peeled: string | null = null;
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') peeled = peelTag(repo.lookup, oid);
    out.push({ name, oid, peeled });
  }
  return out;
}

/** The HEAD line's target: the default branch, born or not. */
function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

const UPLOAD_CAPS_V2: readonly string[] = ['agent=forge/1.0', 'ls-refs', 'fetch=shallow', 'object-format=sha1'];
const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';

/** GET info/refs: a v2 capability advertisement, or a v0 ref advertisement. */
export function infoRefs(repo: Repo, service: string, protocolV2: boolean): GitResponse {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return jsonError(400, `Unknown service ${service}`);
  }
  const contentType = `application/x-${service}-advertisement`;
  if (protocolV2 && service === 'git-upload-pack') {
    const parts: Buffer[] = [pktLine('version 2\n')];
    for (const capability of UPLOAD_CAPS_V2) parts.push(pktLine(`${capability}\n`));
    parts.push(PKT_FLUSH);
    return { status: 200, contentType, body: Buffer.concat(parts) };
  }
  // v0: the service preamble, a flush, then the ref lines (capabilities ride
  // the first one, after a NUL), then a closing flush.
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:${headTarget(repo)}` : RECEIVE_CAPS_V0;
  const refs = advertisedRefs(repo);
  const headTip = repo.refs.get(headTarget(repo));
  const lines: string[] = [];
  if (headTip) lines.push(`${headTip} HEAD`);
  for (const ref of refs) {
    lines.push(`${ref.oid} ${ref.name}`);
    if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}`);
  }
  if (lines.length === 0) lines.push(`${'0'.repeat(40)} capabilities^{}`);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  lines.forEach((line, index) => {
    parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(PKT_FLUSH);
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// upload-pack (v2 ls-refs and fetch, v0 fetch)
// ---------------------------------------------------------------------------------------------

/** One parsed v2 command request: the command, its capability lines and its argument lines. */
interface V2Request {
  readonly command: string;
  readonly args: string[];
}

/** Parse a protocol v2 request body; null when it is not one. */
function parseV2Request(body: Buffer): V2Request | null {
  const { packets, consumed } = decodePktLines(body);
  if (consumed === 0 && packets.length === 0) return null;
  let command = '';
  const args: string[] = [];
  let section = 0; // 0 = command + capabilities, 1 = arguments
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      section = 1;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    args.push(line);
  }
  if (command === '') return null;
  return { command, args };
}

/** The ls-refs answer: HEAD (when asked and unfiltered) then the matching refs. */
function lsRefs(repo: Repo, args: readonly string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const headTip = repo.refs.get(target);
  if (matches('HEAD') || prefixes.length === 0) {
    if (headTip) {
      parts.push(pktLine(`${headTip} HEAD${wantSymrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (wantUnborn) {
      parts.push(pktLine(`unborn HEAD${wantSymrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const ref of advertisedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantPeel && ref.peeled) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Frame pack bytes as sideband band-1 pkt-lines (32 KiB data chunks). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  if (pack.length === 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1])])));
    return parts;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

/** The fetch answer (v2 sections, or the v0 NAK + sideband form). */
function fetchAnswer(forge: Forge, repo: Repo, request: { wants: string[]; haves: string[]; shallow: string[]; depth: number | null }, v2: boolean): Buffer {
  const result = forge.fetchPack(repo, request);
  const parts: Buffer[] = [];
  if (v2) {
    if (request.haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      let acked = false;
      for (const have of request.haves) {
        const object = repo.objects.get(have);
        if (object && object.type === 'commit') {
          parts.push(pktLine(`ACK ${have}\n`));
          acked = true;
        }
      }
      if (!acked) parts.push(pktLine('NAK\n'));
      parts.push(PKT_DELIM);
    }
    if (result.shallow.length > 0 || result.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(result.pack));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  // v0: shallow lines and a NAK as plain packets, then the sideband pack.
  for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPack(result.pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST git-upload-pack: a v2 command (ls-refs / fetch) or a v0 fetch. */
export function uploadPack(forge: Forge, repo: Repo, body: Buffer, protocolV2: boolean): GitResponse {
  const contentType = 'application/x-git-upload-pack-result';
  const v2 = parseV2Request(body);
  if (v2 && (protocolV2 || v2.command !== '')) {
    if (v2.command === 'ls-refs') {
      return { status: 200, contentType, body: lsRefs(repo, v2.args) };
    }
    if (v2.command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | null = null;
      for (const arg of v2.args) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7), 10);
      }
      return { status: 200, contentType, body: fetchAnswer(forge, repo, { wants, haves, shallow, depth }, true) };
    }
    return jsonError(400, `Unknown command ${v2.command}`);
  }
  // v0 fetch: wants (with deepen lines) up to a flush, then haves and done.
  const { packets, consumed } = decodePktLines(body);
  if (consumed === 0 && packets.length === 0) return jsonError(400, 'Malformed upload-pack request');
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets as PktPacket[]) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]);
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
  }
  if (wants.length === 0) return jsonError(400, 'Malformed upload-pack request');
  return { status: 200, contentType, body: fetchAnswer(forge, repo, { wants, haves, shallow, depth }, false) };
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

/** POST git-receive-pack: a command list and a pack, answered with report-status. */
export function receivePack(forge: Forge, repo: Repo, body: Buffer): GitResponse {
  const contentType = 'application/x-git-receive-pack-result';
  let decoded: { packets: PktPacket[]; consumed: number };
  try {
    decoded = decodePktLines(body);
  } catch (err) {
    if (err instanceof GitError) return jsonError(400, err.message);
    throw err;
  }
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let capabilities = '';
  for (const packet of decoded.packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length < 3) return jsonError(400, 'Malformed receive-pack command');
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  // decodePktLines stops where the framing stops (the pack is unframed), so
  // `consumed` is exactly the pack's first byte.
  const pack = body.subarray(decoded.consumed);
  // The report stream: an unpack line, then one ok/ng line per command.
  const report: string[] = [];
  let unpackError: string | null = null;
  try {
    if (pack.length > 0) forge.absorbPack(repo, pack);
  } catch (err) {
    unpackError = err instanceof Error ? err.message : 'unpack failed';
  }
  if (unpackError !== null) {
    report.push(`unpack ${unpackError}`);
    for (const command of commands) report.push(`ng ${command.ref} unpacker error`);
  } else {
    report.push('unpack ok');
    for (const command of commands) {
      const refusal = forge.applyRefUpdate(repo, command.ref, command.oldOid, command.newOid);
      report.push(refusal === null ? `ok ${command.ref}` : `ng ${command.ref} ${refusal}`);
    }
  }
  const reportBytes = Buffer.concat([...report.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  const wantsSideband = capabilities.split(' ').includes('side-band-64k');
  if (wantsSideband) {
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < reportBytes.length; offset += CHUNK) {
      const chunk = reportBytes.subarray(offset, Math.min(reportBytes.length, offset + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(PKT_FLUSH);
    return { status: 200, contentType, body: Buffer.concat(parts) };
  }
  return { status: 200, contentType, body: reportBytes };
}
