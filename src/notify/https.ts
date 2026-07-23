import { promises as dns } from 'dns';
import * as https from 'https';
import * as net from 'net';
import {
  NotificationEventV1,
  NotificationOutcomeV1,
  NotificationOwnerTargetV1,
  outcome,
  ownerMatches,
} from './types';

export interface DnsAddressV1 {
  address: string;
  family: 4 | 6;
}

export interface HttpsTransportInputV1 {
  url: URL;
  address: DnsAddressV1;
  timeout_ms: number;
  maximum_response_bytes: number;
  headers: Readonly<Record<string, string>>;
  payload: string;
}

export interface HttpsTransportOutcomeV1 {
  status_code: number;
  response_bytes: number;
}

export type HttpsResolverV1 = (hostname: string) => Promise<readonly DnsAddressV1[]>;
export type HttpsTransportV1 = (
  input: Readonly<HttpsTransportInputV1>,
) => Promise<HttpsTransportOutcomeV1>;

export interface HttpsNotificationTargetV1 extends NotificationOwnerTargetV1 {
  adapter: 'https';
  enabled: boolean;
  url: string;
  allowed_hosts: readonly string[];
  timeout_ms?: number;
  headers?: Readonly<Record<string, string>>;
}

export interface HttpsNotificationDependenciesV1 {
  resolve?: HttpsResolverV1;
  request?: HttpsTransportV1;
}

const MAX_URL_BYTES = 8 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const BLOCKED_SUFFIXES = [
  '.arpa', '.example', '.home', '.internal', '.invalid', '.lan', '.local', '.localhost', '.onion', '.test',
];

export async function notifyHttps(
  event: Readonly<NotificationEventV1>,
  target: Readonly<HttpsNotificationTargetV1>,
  dependencies: Readonly<HttpsNotificationDependenciesV1> = {},
): Promise<NotificationOutcomeV1> {
  const destination = target.url;
  if (!target.enabled) return outcome('https', 'skipped', 'HTTPS_DISABLED', event, destination);
  if (!ownerMatches(event, target)) {
    return outcome('https', 'failed', 'HTTPS_OWNER_MISMATCH', event, destination);
  }
  const validated = validateEndpoint(target);
  if (validated === null) {
    return outcome('https', 'failed', 'HTTPS_ENDPOINT_REJECTED', event, destination);
  }
  const resolve = dependencies.resolve ?? defaultResolver;
  let first: DnsAddressV1[];
  let second: DnsAddressV1[];
  try {
    first = normalizeAddresses(await resolve(validated.url.hostname));
    second = normalizeAddresses(await resolve(validated.url.hostname));
  } catch (error) {
    return outcome('https', 'failed', 'HTTPS_DNS_FAILED', event, destination,
      error instanceof Error ? error.message : String(error));
  }
  if (first.length === 0 || second.length === 0 || !sameAddressSet(first, second)
    || first.some((address) => !publicAddress(address.address, address.family))) {
    return outcome('https', 'failed', 'HTTPS_DNS_REVALIDATION_REJECTED', event, destination);
  }
  const payload = JSON.stringify(event);
  if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    return outcome('https', 'failed', 'HTTPS_PAYLOAD_TOO_LARGE', event, destination);
  }
  const request = dependencies.request ?? defaultHttpsTransport;
  try {
    const response = await request({
      url: validated.url,
      address: second[0],
      timeout_ms: validated.timeout,
      maximum_response_bytes: MAX_RESPONSE_BYTES,
      headers: validated.headers,
      payload,
    });
    return response.status_code >= 200 && response.status_code < 300
      ? outcome('https', 'delivered', 'HTTPS_DELIVERED', event, destination)
      : outcome('https', 'failed', 'HTTPS_STATUS_REJECTED', event, destination,
        `remote status ${response.status_code}`);
  } catch (error) {
    return outcome('https', 'failed', 'HTTPS_DELIVERY_FAILED', event, destination,
      error instanceof Error ? error.message : String(error));
  }
}

function validateEndpoint(
  target: Readonly<HttpsNotificationTargetV1>,
): { url: URL; timeout: number; headers: Record<string, string> } | null {
  if (Buffer.byteLength(target.url, 'utf8') > MAX_URL_BYTES || target.allowed_hosts.length < 1
    || target.allowed_hosts.length > 32) return null;
  let url: URL;
  try { url = new URL(target.url); } catch (_) { return null; }
  const hostname = normalizeHost(url.hostname);
  const allowed = new Set(target.allowed_hosts.map(normalizeHost));
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || (url.port !== '' && url.port !== '443') || url.hash !== '' || url.search !== ''
    || hostname.length > 253 || !hostname.includes('.') || net.isIP(hostname) !== 0
    || blockedHostname(hostname) || !allowed.has(hostname)
    || [...allowed].some((host) => !validAllowedHost(host))) return null;
  const timeout = target.timeout_ms ?? 3_000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 5_000) return null;
  const headers = normalizeHeaders(target.headers ?? {});
  if (headers === null) return null;
  return { url, timeout, headers };
}

function normalizeHeaders(input: Readonly<Record<string, string>>): Record<string, string> | null {
  const entries = Object.entries(input);
  if (entries.length > 16) return null;
  const output: Record<string, string> = {};
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/u.test(lower)
      || ['connection', 'content-length', 'host', 'transfer-encoding'].includes(lower)
      || Buffer.byteLength(value, 'utf8') > 4096 || /[\0\r\n]/u.test(value)) return null;
    output[lower] = value;
  }
  return output;
}

async function defaultResolver(hostname: string): Promise<readonly DnsAddressV1[]> {
  const entries = await dns.lookup(hostname, { all: true, verbatim: true });
  return entries.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
}

function defaultHttpsTransport(
  input: Readonly<HttpsTransportInputV1>,
): Promise<HttpsTransportOutcomeV1> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = https.request({
      protocol: 'https:',
      hostname: input.url.hostname,
      servername: input.url.hostname,
      port: 443,
      path: input.url.pathname,
      method: 'POST',
      headers: {
        ...input.headers,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(input.payload, 'utf8'),
        'user-agent': 'oh-my-agy-notify/1',
      },
      lookup: (_hostname, _options, callback) => {
        callback(null, input.address.address, input.address.family);
      },
      rejectUnauthorized: true,
      timeout: input.timeout_ms,
    }, (response) => {
      let bytes = 0;
      response.on('data', (chunk: Buffer | string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > input.maximum_response_bytes) {
          response.destroy(new Error('HTTPS response exceeded bound'));
        }
      });
      response.once('error', finishError);
      response.once('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status_code: response.statusCode ?? 0, response_bytes: bytes });
      });
    });
    request.once('timeout', () => request.destroy(new Error('HTTPS request timed out')));
    request.once('error', finishError);
    request.end(input.payload);
  });
}

function normalizeAddresses(input: readonly DnsAddressV1[]): DnsAddressV1[] {
  const unique = new Map<string, DnsAddressV1>();
  for (const entry of input) {
    if ((entry.family !== 4 && entry.family !== 6) || net.isIP(entry.address) !== entry.family) continue;
    unique.set(`${entry.family}:${entry.address.toLowerCase()}`, {
      family: entry.family,
      address: entry.address.toLowerCase(),
    });
  }
  return [...unique.values()].sort((left, right) =>
    left.family - right.family || Buffer.from(left.address).compare(Buffer.from(right.address)));
}

function sameAddressSet(left: readonly DnsAddressV1[], right: readonly DnsAddressV1[]): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry.family === right[index].family
      && entry.address === right[index].address);
}

export function publicAddress(address: string, family: 4 | 6): boolean {
  if (family === 4) return publicIpv4(address);
  const bytes = ipv6Bytes(address);
  if (bytes === null) return false;
  if (bytes.slice(0, 12).every((entry, index) => entry === (index >= 10 ? 0xff : 0))) {
    return publicIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  if (bytes.every((entry) => entry === 0) || (bytes.slice(0, 15).every((entry) => entry === 0) && bytes[15] === 1)) return false;
  if (bytes.slice(0, 12).every((entry) => entry === 0)) return false;
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return false;
  if ((bytes[0] & 0xfe) === 0xfc || (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80)
    || (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) || bytes[0] === 0xff) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01
    && ((bytes[2] === 0x0d && bytes[3] === 0xb8)
      || (bytes[2] === 0x00 && bytes[3] === 0x02)
      || ((bytes[2] & 0xf0) === 0x10) || (bytes[2] === 0x00 && bytes[3] === 0x00))) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false;
  if (bytes[0] === 0x01 && bytes.slice(1, 8).every((entry) => entry === 0)) return false;
  return true;
}

function publicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b, c] = octets;
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113));
}

function ipv6Bytes(address: string): number[] | null {
  let source = address.toLowerCase();
  const zone = source.indexOf('%');
  if (zone >= 0) source = source.slice(0, zone);
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const words: number[] = [];
    for (const part of side.split(':')) {
      if (part.includes('.')) {
        const octets = part.split('.').map(Number);
        if (octets.length !== 4 || octets.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 255)) return null;
        words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(part)) return null;
        words.push(parseInt(part, 16));
      }
    }
    return words;
  };
  const left = parseSide(halves[0]);
  const right = parseSide(halves[1] ?? '');
  if (left === null || right === null) return null;
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return null;
  const words = [...left, ...Array(Math.max(0, omitted)).fill(0), ...right];
  if (words.length !== 8) return null;
  return words.flatMap((word) => [word >>> 8, word & 0xff]);
}

function normalizeHost(value: string): string {
  return value.toLowerCase().replace(/\.$/u, '');
}

function validAllowedHost(host: string): boolean {
  return host.length > 0 && host.length <= 253 && host.includes('.') && net.isIP(host) === 0
    && !blockedHostname(host) && /^[a-z0-9.-]+$/u.test(host)
    && host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
}

function blockedHostname(host: string): boolean {
  return host === 'localhost' || host === 'metadata.google.internal'
    || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
