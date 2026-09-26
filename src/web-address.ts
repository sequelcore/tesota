import { BlockList, isIP } from "node:net";

/**
 * Whether a page may be read from an address (decision 024): only addresses
 * on the public internet. Tesota reads pages from the operator's own
 * computer, outside any sandbox, so an address that reaches that computer or
 * its network (loopback, private, link-local, shared carrier NAT) is refused,
 * with IANA's other special-purpose ranges. An IPv4 address carried inside an
 * IPv6 one (mapped, NAT64) is judged by the IPv4 address it carries.
 */

const nonPublic = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) {
  nonPublic.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [["::", 128], ["::1", 128], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) {
  nonPublic.addSubnet(network, prefix, "ipv6");
}

/** The IPv4 address an IPv6 address carries as IPv4-mapped (`::ffff:a.b.c.d`) or NAT64 (`64:ff9b::/96`), if it does. */
function carriedIpv4(address: string): string | undefined {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(lower);
  if (dotted !== null) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(lower);
  if (hex === null) return undefined;
  const high = Number.parseInt(hex[1] ?? "0", 16);
  const low = Number.parseInt(hex[2] ?? "0", 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !nonPublic.check(address, "ipv4");
  if (family !== 6) return false;
  const carried = carriedIpv4(address);
  if (carried !== undefined) return isIP(carried) === 4 && !nonPublic.check(carried, "ipv4");
  return !nonPublic.check(address, "ipv6");
}
