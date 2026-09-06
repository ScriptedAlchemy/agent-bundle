import { BlockList, isIP } from 'node:net';

type Family = 'ipv4' | 'ipv6';

const blockList = (family: Family, subnets: readonly string[]): BlockList => {
  const list = new BlockList();
  for (const subnet of subnets) {
    const [address, prefix] = subnet.split('/') as [string, string];
    list.addSubnet(address, Number(prefix), family);
  }
  return list;
};

/** IANA IPv4 Special-Purpose Address Registry: never globally reachable. */
const specialIpv4 = blockList('ipv4', [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.31.196.0/24', '192.52.193.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '192.175.48.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
]);

/** IANA IPv6 Special-Purpose Address Registry: never globally reachable. */
const specialIpv6 = blockList('ipv6', [
  '::/96', '::ffff:0:0/96', '64:ff9b::/96', '64:ff9b:1::/48', '100::/64', '100:0:0:1::/64',
  '2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20', '5f00::/16', 'fc00::/7', 'fe80::/10', 'ff00::/8',
]);

const globalUnicastIpv6 = blockList('ipv6', ['2000::/3']);

const bareAddress = (host: string): string => host.replace(/^\[|\]$/gu, '');

/** An IP literal (brackets allowed) inside an IANA special-purpose range; hostnames are never special. */
export const isSpecialPurposeIp = (host: string): boolean => {
  const address = bareAddress(host);
  const version = isIP(address);
  if (version === 4) return specialIpv4.check(address, 'ipv4');
  return version === 6 && specialIpv6.check(address, 'ipv6');
};

/** An IPv6 literal (brackets allowed) outside global unicast `2000::/3`. */
export const isNonGlobalUnicastIpv6 = (host: string): boolean => {
  const address = bareAddress(host);
  return isIP(address) === 6 && !globalUnicastIpv6.check(address, 'ipv6');
};
