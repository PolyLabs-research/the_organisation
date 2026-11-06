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
/** Resolve once, reject mixed public/private answers, then use this address for the connection. */
export async function publicAddress(host: string): Promise<string> {
  serviceURL('https://' + host);
  let addresses;
  try { addresses = await lookup(host, { all: true }); } catch { throw new AccessError('The mail or service hostname could not be resolved.'); }
  if (!addresses.length || addresses.some(item => !publicIP(item.address))) throw new AccessError('Business connections cannot reach private or reserved network addresses.', 403);
  return (addresses.find(item => item.family === 4) ?? addresses[0])!.address;
}
