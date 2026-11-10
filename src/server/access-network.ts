import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { AccessError } from './access-vault';

export function publicIP(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function serviceURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AccessError('Use a complete HTTPS address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new AccessError('Use an HTTPS address on port 443, without credentials in the URL.');
  if (!/^[a-z0-9.-]+$/.test(url.hostname) || !url.hostname.includes('.') || url.hostname.endsWith('.') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname) || ipaddr.isValid(url.hostname)) {
    throw new AccessError('Use a public service hostname, not a local address or an IP address.');
  }
  return url;
}
/**
 * The address of a tool server. A person gives it and no agent ever chooses it, so it may be a server on a private
 * network or on this machine. What goes to it can include a token, so it travels over HTTPS; plain HTTP is only for
 * this machine itself, where nothing leaves it.
 */
export function toolServerURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AccessError('Give the server’s whole address, such as https://tools.example.com/mcp.'); }
  if (url.username || url.password) throw new AccessError('Leave credentials out of the address. A token goes in its own field.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const here = host === 'localhost' || (ipaddr.isValid(host) && ipaddr.process(host).range() === 'loopback');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && here)) throw new AccessError('Use an HTTPS address. Plain HTTP is only for a server on this machine, at localhost.');
  url.hash = '';
  return url;
}
/** Where an address is, as far as trust goes: on this machine, inside the network this machine is on, or out on the internet. */
export type Reach = 'here' | 'inside' | 'outside';
const FURTHER_OUT: Reach[] = ['here', 'inside', 'outside'];
export type Resolver = (host: string) => Promise<string[]>;
const resolved: Resolver = async host => (await lookup(host, { all: true })).map(item => item.address);
/** Where an address is. A name is looked up, and counts as inside if any of its addresses is. */
export async function reachOf(url: URL, resolve: Resolver = resolved): Promise<Reach> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const of = (address: string): Reach => { const range = ipaddr.process(address).range(); return range === 'loopback' ? 'here' : range === 'unicast' ? 'outside' : 'inside'; };
  if (host === 'localhost') return 'here';
  if (ipaddr.isValid(host)) return of(host);
  let addresses: string[];
  try { addresses = await resolve(host); } catch { throw new AccessError('The address ' + host.slice(0, 100) + ' could not be found.', 502); }
  if (!addresses.length) throw new AccessError('The address ' + host.slice(0, 100) + ' could not be found.', 502);
  return addresses.map(of).sort((a, b) => FURTHER_OUT.indexOf(a) - FURTHER_OUT.indexOf(b))[0]!;
}
/**
 * An address a tool server names for signing in: where its sign-in is, where a token is asked for. No person chose
 * it, so a server may not name one that is further in than the server itself is: one out on the internet cannot
 * send this program, or the person's browser, to an address on this machine or inside its network. Like the
 * server's own address it is HTTPS, or plain HTTP on this machine only.
 */
export async function signInURL(value: string | URL, server: Reach, resolve: Resolver = resolved): Promise<URL> {
  let url: URL;
  try { url = toolServerURL(String(value)); } catch { throw new AccessError('The server’s sign-in is at an address that cannot be used: it has to be HTTPS.', 502); }
  if (FURTHER_OUT.indexOf(await reachOf(url, resolve)) < FURTHER_OUT.indexOf(server)) throw new AccessError('The server’s sign-in points to an address ' + (server === 'outside' ? 'inside this network or on this machine' : 'on this machine') + ', which a server further out may not send this program to.', 502);
  return url;
}
/** Headers that belong to the connection or to the protocol. A token cannot be sent in one of them. */
const NOT_FOR_A_TOKEN = new Set(['host', 'connection', 'content-length', 'content-type', 'transfer-encoding', 'accept', 'te', 'trailer', 'upgrade', 'origin', 'referer', 'user-agent', 'cookie', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']);
/** The header a tool server reads its token from: Authorization unless the service names another. */
export function tokenHeader(name: string): string {
  if (NOT_FOR_A_TOKEN.has(name.toLowerCase())) throw new AccessError('That header belongs to the connection itself. Give the one the service reads its key from, such as X-API-Key.');
  return name.toLowerCase() === 'authorization' ? 'Authorization' : name;
}
/** Resolve once, reject mixed public/private answers, then use this address for the connection. */
export async function publicAddress(host: string): Promise<string> {
  serviceURL('https://' + host);
  let addresses;
  try { addresses = await lookup(host, { all: true }); } catch { throw new AccessError('The mail or service hostname could not be resolved.'); }
  if (!addresses.length || addresses.some(item => !publicIP(item.address))) throw new AccessError('Business connections cannot reach private or reserved network addresses.', 403);
  return (addresses.find(item => item.family === 4) ?? addresses[0])!.address;
}
