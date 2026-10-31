// Egress guard for URLs a *user* supplied (ICS/RSS feeds, custom AI and voice servers, IMAP hosts).
// Resolve once, require every address to pass, then dial the validated address (pinned) so DNS rebinding cannot
// swap the target between the check and the connection. Operator-declared provider URLs (env) do not come here.
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { HttpError } from '../errors.js';

/** Never reachable, not even with ALLOW_PRIVATE_FETCH or an allow entry (cloud metadata, unspecified, multicast). */
const ALWAYS = new BlockList();
ALWAYS.addAddress('169.254.169.254');
ALWAYS.addAddress('169.254.170.2'); // ECS task metadata
ALWAYS.addAddress('100.100.100.200'); // Alibaba metadata
ALWAYS.addAddress('fd00:ec2::254', 'ipv6');
ALWAYS.addSubnet('0.0.0.0', 8);
ALWAYS.addSubnet('224.0.0.0', 4); // multicast
ALWAYS.addSubnet('240.0.0.0', 4); // reserved + broadcast
ALWAYS.addAddress('::', 'ipv6');
ALWAYS.addSubnet('ff00::', 8, 'ipv6');
ALWAYS.addSubnet('2001::', 32, 'ipv6'); // Teredo tunnels

const METADATA_NAMES = new Set(['metadata.google.internal', 'metadata', 'metadata.azure.internal', 'instance-data']);

/** Private, loopback, link-local, CGNAT/tailnet, ULA and other non-global space: refused by default. */
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
]) {
  PRIVATE.addSubnet(net, bits);
}
for (const [net, bits] of [
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['100::', 64],
  ['2001:db8::', 32],
  ['64:ff9b:1::', 48], // local-use NAT64 (RFC 8215): an IPv4 address of the operator's choosing inside
  ['::ffff:0:0:0', 96], // IPv4-translated (SIIT), ::ffff:0:a.b.c.d
]) {
  PRIVATE.addSubnet(net, bits, 'ipv6');
}

export class EgressRefused extends HttpError {
  constructor(message) {
    super(400, 'blocked_address', message);
    this.name = 'EgressRefused';
  }
}

/**
 * IPv4 inside IPv6 (mapped ::ffff:a.b.c.d, NAT64 64:ff9b::/96, 6to4 2002::/16, the old IPv4-compatible ::a.b.c.d)
 * -> the IPv4 address.
 */
export function embeddedV4(address) {
  const a = address.toLowerCase();
  const mapped =
    a.match(/^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/) ??
    a.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/) ??
    a.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  const hexMapped =
    a.match(/^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/) ??
    a.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/) ??
    a.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  const sixToFour = a.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
  const m = hexMapped ?? sixToFour;
  if (!m) return undefined;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function familyOf(address) {
  return isIP(address) === 6 ? 'ipv6' : 'ipv4';
}

/** 'blocked' | 'private' | 'public' for one literal address. */
export function classify(address) {
  const v4 = isIP(address) === 6 ? embeddedV4(address) : undefined;
  const target = v4 ?? address;
  const type = familyOf(target);
  if (ALWAYS.check(target, type)) return 'blocked';
  if (PRIVATE.check(target, type)) return 'private';
  return 'public';
}

/**
 * Builds the request policy from config: allowPrivate (ALLOW_PRIVATE_FETCH) and allow entries (FETCH_ALLOW):
 * CIDRs ("100.64.0.0/10"), single IPs, host names or host:port pairs.
 */
export function makePolicy({ allowPrivate = false, allow = [] } = {}) {
  const nets = new BlockList();
  const hosts = [];
  for (const entry of allow) {
    const cidr = entry.match(/^([0-9a-f:.]+)\/(\d{1,3})$/i);
    if (cidr && isIP(cidr[1])) {
      nets.addSubnet(cidr[1], Number(cidr[2]), familyOf(cidr[1]));
    } else if (isIP(entry)) {
      nets.addAddress(entry, familyOf(entry));
    } else {
      const m = entry.toLowerCase().match(/^([a-z0-9.-]+)(?::(\d+))?$/);
      if (!m) throw new Error(`FETCH_ALLOW: bad entry "${entry}"`);
      hosts.push({ host: m[1], port: m[2] ? Number(m[2]) : undefined });
    }
  }
  return {
    allowPrivate,
    allowsAddress(address) {
      const v4 = isIP(address) === 6 ? embeddedV4(address) : undefined;
      const target = v4 ?? address;
      return nets.check(target, familyOf(target));
    },
    allowsHost(hostname, port) {
      return hosts.some((h) => h.host === hostname && (h.port === undefined || h.port === port));
    },
  };
}

const defaultResolver = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((r) => r.address);

function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Checks a user URL and resolves it. Returns the validated address to dial.
 * @param {string | URL} input
 * @param {ReturnType<typeof makePolicy>} policy
 * @param {(host: string) => Promise<string[]>} [resolver]
 */
export async function checkUrl(input, policy, resolver = defaultResolver) {
  let url;
  try {
    url = input instanceof URL ? input : new URL(String(input));
  } catch {
    throw new HttpError(400, 'invalid_url', 'That is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'invalid_url', 'Only http and https URLs are supported');
  }
  if (url.username || url.password) throw new HttpError(400, 'invalid_url', 'URLs with a user name or password are not allowed');
  const host = stripBrackets(url.hostname).toLowerCase().replace(/\.$/, '');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return { url, ...(await checkHost(host, port, policy, resolver)) };
}

/** Same rules for a bare host + port (IMAP). */
export async function checkHost(hostname, port, policy, resolver = defaultResolver) {
  const host = stripBrackets(String(hostname)).toLowerCase().replace(/\.$/, '');
  if (!host) throw new HttpError(400, 'invalid_url', 'Missing host');
  if (METADATA_NAMES.has(host)) throw new EgressRefused('That address is not allowed');
  let addresses;
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await resolver(host);
    } catch {
      throw new HttpError(502, 'dns_failed', `Could not find ${host}`);
    }
  }
  if (!addresses?.length) throw new HttpError(502, 'dns_failed', `Could not find ${host}`);
  const hostAllowed = policy.allowsHost(host, port);
  for (const address of addresses) {
    const cls = classify(address);
    if (cls === 'blocked') throw new EgressRefused('That address is not allowed');
    if (cls === 'private' && !policy.allowPrivate && !hostAllowed && !policy.allowsAddress(address)) {
      throw new EgressRefused(
        `${host} is on a private network. The server owner can allow it with ALLOW_PRIVATE_FETCH or FETCH_ALLOW.`,
      );
    }
  }
  return { host, port, address: addresses[0], family: isIP(addresses[0]) };
}
