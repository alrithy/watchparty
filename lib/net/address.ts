import ipaddr from "ipaddr.js";

/**
 * Whether an IP address is a public, routable unicast address a server-side
 * fetch may connect to. Everything else (loopback, private, link-local and
 * cloud metadata, CGNAT, multicast, documentation, benchmarking, NAT64, 6to4,
 * Teredo, IPv4-mapped/compatible IPv6 of a private address...) is refused.
 *
 * ipaddr.js (MIT) does the range table; IPv4-mapped IPv6 such as
 * `::ffff:7f00:1` is unwrapped to its IPv4 first, which is the form Node's URL
 * parser produces for `http://[::ffff:127.0.0.1]/`.
 */
export function isPublicAddress(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(ip.replace(/^\[|\]$/g, "").replace(/%.*$/, ""));
  } catch {
    return false;
  }
  if (addr.range() !== "unicast") return false;
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    // Only global unicast (2000::/3). This also refuses IPv4-compatible ::a.b.c.d (::/96).
    if (!v6.match(ipaddr.IPv6.parse("2000::"), 3)) return false;
  }
  return true;
}
