import { beforeEach, describe, expect, it, vi } from 'vitest';

// The name lookup is the one thing here that would leave the machine, so it is stood in for.
const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

import { publicAddress } from '../src/server/access-network';

const resolvesTo = (...addresses: string[]) => lookup.mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

beforeEach(() => {
  lookup.mockReset();
});

describe('where a mailbox or an account may be reached', () => {
  it('gives the one address a public host resolves to, and the IPv4 one where there are both', async () => {
    resolvesTo('93.184.215.14');
    expect(await publicAddress('imap.paperclips.example')).toBe('93.184.215.14');
    expect(lookup).toHaveBeenCalledWith('imap.paperclips.example', { all: true });
    resolvesTo('2606:2800:21f:cb07:6820:80da:af6b:8b2c', '93.184.215.14');
    expect(await publicAddress('imap.paperclips.example')).toBe('93.184.215.14');
    resolvesTo('2606:2800:21f:cb07:6820:80da:af6b:8b2c');
    expect(await publicAddress('imap.paperclips.example')).toBe('2606:2800:21f:cb07:6820:80da:af6b:8b2c');
  });

  it('refuses a host that resolves to a private, local or reserved address', async () => {
    // A name anyone can register, pointed at a machine only this network can see: the router, a cloud's
    // metadata service, this computer itself.
    for (const inside of ['10.0.0.5', '192.168.1.10', '172.16.4.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.5', '::ffff:127.0.0.1']) {
      resolvesTo(inside);
      await expect(publicAddress('mail.attacker.example'), inside).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/private or reserved network addresses/) });
    }
  });

  it('refuses a host if any one of its addresses is private, however many are not', async () => {
    resolvesTo('93.184.215.14', '10.0.0.5');
    await expect(publicAddress('mail.attacker.example')).rejects.toMatchObject({ status: 403 });
    resolvesTo('10.0.0.5', '93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c');
    await expect(publicAddress('mail.attacker.example')).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a name that resolves to nothing, or does not resolve', async () => {
    resolvesTo();
    await expect(publicAddress('mail.nowhere.example')).rejects.toMatchObject({ status: 403 });
    lookup.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    await expect(publicAddress('mail.nowhere.example')).rejects.toThrow(/could not be resolved/);
  });

  it('does not so much as look up what is not a public host name', async () => {
    for (const name of ['localhost', 'printer.local', 'db.internal', '10.0.0.5', 'intranet', 'mail.example.']) {
      await expect(publicAddress(name), name).rejects.toThrow(/public service hostname|HTTPS address/);
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});
