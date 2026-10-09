import { describe, expect, test } from 'vitest';

import { splitKnownHost } from '../../src/components/connections/KnownHostsDialog';

/**
 * The listing returns the field exactly as `known_hosts` spells it; the API wants the
 * host and port separately and rebuilds the key itself. Getting this wrong sent
 * `[127.0.0.1]:64823:64823` and the delete answered 404.
 */
describe('splitKnownHost', () => {
  test('a default-port entry is a bare host', () => {
    expect(splitKnownHost('github.com')).toEqual({ host: 'github.com', port: 22 });
  });

  test('a non-default port is bracketed, and the brackets come off', () => {
    expect(splitKnownHost('[127.0.0.1]:64823')).toEqual({ host: '127.0.0.1', port: 64823 });
    expect(splitKnownHost('[2001:db8::1]:2222')).toEqual({ host: '2001:db8::1', port: 2222 });
  });

  test('a bare IPv6 address is not mistaken for host:port', () => {
    // No brackets means port 22, even though the address is full of colons.
    expect(splitKnownHost('2001:db8::1')).toEqual({ host: '2001:db8::1', port: 22 });
  });

  test('an explicit port 22 written in brackets still round-trips', () => {
    expect(splitKnownHost('[example.com]:22')).toEqual({ host: 'example.com', port: 22 });
  });
});
