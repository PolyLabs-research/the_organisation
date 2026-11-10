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
