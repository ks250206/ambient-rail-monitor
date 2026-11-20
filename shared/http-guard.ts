import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, isIPv4, isIPv6, type LookupFunction } from 'node:net';
import { networkInterfaces } from 'node:os';

/** Thrown when an HTTP stage target is refused by the SSRF policy. */
export class BlockedHttpTarget extends Error {}

/** Link-local, cloud metadata and unspecified addresses are never reachable from HTTP stages. */
const forbidden = new BlockList();
forbidden.addSubnet('0.0.0.0', 8, 'ipv4');
forbidden.addSubnet('169.254.0.0', 16, 'ipv4');
forbidden.addAddress('::', 'ipv6');
forbidden.addSubnet('fe80::', 10, 'ipv6');
forbidden.addAddress('fd00:ec2::254', 'ipv6');

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

/** Expand an IPv6 literal (optionally with an embedded dotted IPv4 tail) to 16 bytes. */
function ipv6Bytes(address: string): number[] | null {
  let text = address.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (!isIPv6(text)) return null;
  let tail: number[] = [];
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    tail = dotted[2].split('.').map(Number);
    text = dotted[1] + '0:0';
  }
  const [head, rest] = text.includes('::') ? text.split('::') : [text, undefined];
  const left = head ? head.split(':') : [];
  const right = rest === undefined ? [] : rest ? rest.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? left.length !== 8 : missing < 0) return null;
  const groups = [
    ...left,
    ...Array.from({ length: rest === undefined ? 0 : missing }, () => '0'),
    ...right,
  ];
  const bytes = groups.flatMap((group) => {
    const value = Number.parseInt(group || '0', 16);
    return [(value >> 8) & 0xff, value & 0xff];
  });
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

/**
 * Normalise an address so IPv4 rules also cover IPv4-mapped (::ffff:a.b.c.d),
 * IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::/96) IPv6 spellings.
 */
export function canonicalAddress(address: string): { address: string; family: 'ipv4' | 'ipv6' } {
  const plain = address.replace(/^\[|\]$/g, '');
  if (isIPv4(plain)) return { address: plain, family: 'ipv4' };
  const bytes = ipv6Bytes(plain);
  if (!bytes) return { address: plain, family: 'ipv6' };
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);
  const embedded =
    (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) ||
    (zeros(0, 12) && !zeros(12, 16) && !(zeros(12, 15) && bytes[15] === 1)) ||
    (bytes[0] === 0x00 &&
      bytes[1] === 0x64 &&
      bytes[2] === 0xff &&
      bytes[3] === 0x9b &&
      zeros(4, 12));
  if (embedded) return { address: bytes.slice(12).join('.'), family: 'ipv4' };
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return { address: groups.join(':'), family: 'ipv6' };
}

export function isForbiddenAddress(address: string): boolean {
  const canonical = canonicalAddress(address);
  return forbidden.check(canonical.address, canonical.family);
}

export interface SelfTarget {
  /** Port of Railflow's own control API (as seen by the worker). */
  port: number;
  /** Addresses that reach the control API, in addition to loopback and local interfaces. */
  addresses: string[];
}

function defaultPort(url: URL): number {
  return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
}

export function selfTargetFor(apiOrigin: string | undefined): SelfTarget | undefined {
  if (!apiOrigin) return undefined;
  const url = new URL(apiOrigin);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return { port: defaultPort(url), addresses: isIP(host) ? [host] : [] };
}

function localAddresses(): Set<string> {
  const result = new Set<string>();
  for (const list of Object.values(networkInterfaces()))
    for (const item of list ?? []) result.add(canonicalAddress(item.address).address);
  return result;
}

/** True when this address/port pair would reach Railflow's own control API. */
export function isSelfAddress(address: string, port: number, self?: SelfTarget): boolean {
  if (!self || port !== self.port) return false;
  const canonical = canonicalAddress(address);
  if (loopback.check(canonical.address, canonical.family)) return true;
  if (self.addresses.some((item) => canonicalAddress(item).address === canonical.address))
    return true;
  return localAddresses().has(canonical.address);
}

function refuse(address: string, port: number, self?: SelfTarget): string | undefined {
  if (isForbiddenAddress(address)) return 'リンクローカルまたはメタデータURLには接続できません。';
  if (isSelfAddress(address, port, self))
    return 'HTTPステージからRailflow自身のコントロールAPIには接続できません。';
  return undefined;
}

/** Validate a URL whose host is an IP literal; DNS names are validated at connect time. */
export function assertAllowedUrl(url: URL, self?: SelfTarget): void {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = defaultPort(url);
  if (isIP(host)) {
    const reason = refuse(host, port, self);
    if (reason) throw new BlockedHttpTarget(reason);
  } else if (self && port === self.port && host.toLowerCase().replace(/\.$/, '') === 'localhost')
    throw new BlockedHttpTarget(
      'HTTPステージからRailflow自身のコントロールAPIには接続できません。',
    );
}

/**
 * DNS lookup that checks every resolved address before the socket connects, so a
 * hostname cannot be re-pointed at a forbidden address between check and use.
 */
export type Resolver = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export function guardedLookup(
  port: number,
  self?: SelfTarget,
  resolve: Resolver = dnsLookup as unknown as Resolver,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0);
      const list = addresses ?? [];
      for (const item of list) {
        const reason = refuse(item.address, port, self);
        if (reason) return callback(new BlockedHttpTarget(reason), '', 0);
      }
      if (!list.length) return callback(new Error(`名前解決できません: ${hostname}`), '', 0);
      if ((options as { all?: boolean }).all)
        return (callback as unknown as (err: null, all: LookupAddress[]) => void)(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

export interface GuardedResponse {
  status: number;
  body: Buffer;
}

/** Single HTTP request with no redirects, a pinned/validated destination and a body cap. */
export function guardedRequest(
  url: URL,
  options: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    maxBytes: number;
    expectStatus: number;
    self?: SelfTarget;
  },
): Promise<GuardedResponse> {
  try {
    assertAllowedUrl(url, options.self);
  } catch (error) {
    return Promise.reject(error);
  }
  const port = defaultPort(url);
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: options.method,
        headers: {
          ...options.headers,
          ...(options.body !== undefined
            ? { 'content-length': String(Buffer.byteLength(options.body)) }
            : {}),
        },
        signal: options.signal,
        lookup: guardedLookup(port, options.self),
        agent: false,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status !== options.expectStatus) {
          response.resume();
          response.destroy();
          return reject(new Error(`HTTP ${status}（期待 ${options.expectStatus}）`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > options.maxBytes) {
            response.destroy();
            reject(new Error(`HTTPレスポンスの上限は${options.maxBytes / 1024 / 1024} MiBです。`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}
