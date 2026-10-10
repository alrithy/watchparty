import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { isPublicAddress } from "@/lib/net/address";
import { isPrivateAddress, probeUrl } from "@/lib/media/probe";
import { pinnedFetch } from "@/lib/net/pinned-fetch";

describe("isPublicAddress", () => {
  it.each([
    // The URL parser turns http://[::ffff:127.0.0.1]/ into this hex form; it was treated as public before.
    ["::ffff:7f00:1", false],
    ["::ffff:a9fe:a9fe", false],
    ["::ffff:127.0.0.1", false],
    ["::7f00:1", false],
    ["64:ff9b::7f00:1", false],
    ["2002:7f00:1::", false],
    ["2001::1", false],
    ["2001:db8::1", false],
    ["fec0::1", false],
    ["fe80::1%eth0", false],
    ["::", false],
    ["0.0.0.0", false],
    ["0.1.2.3", false],
    ["127.0.0.1", false],
    ["10.0.0.1", false],
    ["172.16.0.1", false],
    ["192.168.0.1", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["192.0.0.1", false],
    ["192.0.2.1", false],
    ["198.18.0.1", false],
    ["198.51.100.1", false],
    ["203.0.113.1", false],
    ["224.0.0.1", false],
    ["255.255.255.255", false],
    ["not-an-ip", false],
    // Public: includes 192.0.78.x (WordPress.com), which the old 192.0.0.0/16 rule refused.
    ["192.0.78.9", true],
    ["8.8.8.8", true],
    ["93.184.216.34", true],
    ["2606:4700::1111", true],
    ["[2a00:1450:4001::200e]", true],
  ])("%s public=%s", (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });

  it("isPrivateAddress is its complement", () => {
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });

  it("refuses an IPv4-mapped IPv6 URL host before any request", async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return new Response("");
    }) as unknown as typeof fetch;
    expect(await probeUrl("http://[::ffff:127.0.0.1]/x", { fetchImpl: f })).toEqual({ result: "unknown" });
    expect(called).toBe(false);
  });
});

describe("pinnedFetch", () => {
  let server: http.Server;
  let port = 0;
  let lastHeaders: http.IncomingHttpHeaders = {};
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastHeaders = req.headers;
      if (req.url === "/gz") {
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        res.end(zlib.gzipSync("<title>zipped</title>"));
        return;
      }
      res.writeHead(200, { "content-type": "text/plain", "set-cookie": "a=b" });
      res.end("hello");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("refuses loopback literals", async () => {
    await expect(pinnedFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(/not allowed/);
    await expect(pinnedFetch(`http://[::ffff:127.0.0.1]:${port}/`)).rejects.toThrow(/not allowed/);
  });

  it("checks the address at connect time, so a name that resolves privately is refused", async () => {
    // "localhost" stands in for a rebinding host: whatever an earlier check saw, the socket's own lookup decides.
    await expect(pinnedFetch(`http://localhost:${port}/`)).rejects.toThrow(/not allowed/);
  });

  it("strips credentials and cookies, and drops Set-Cookie", async () => {
    const res = await pinnedFetch(`http://127.0.0.1:${port}/`, {
      allowPrivate: true,
      headers: { Authorization: "Bearer RD-SECRET", Cookie: "session=1", Range: "bytes=0-0" },
    });
    expect(await res.text()).toBe("hello");
    expect(lastHeaders.authorization).toBeUndefined();
    expect(lastHeaders.cookie).toBeUndefined();
    expect(lastHeaders.range).toBe("bytes=0-0");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses URLs with userinfo", async () => {
    await expect(pinnedFetch(`http://user:pw@127.0.0.1:${port}/`, { allowPrivate: true })).rejects.toThrow(/not allowed/);
  });

  it("decodes gzip only when asked", async () => {
    const res = await pinnedFetch(`http://127.0.0.1:${port}/gz`, { allowPrivate: true, decompress: true });
    expect(await res.text()).toBe("<title>zipped</title>");
    expect(lastHeaders["accept-encoding"]).toMatch(/gzip/);
    const raw = await pinnedFetch(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    await raw.text();
    expect(lastHeaders["accept-encoding"]).toBe("identity");
  });

  it("honours abort signals", async () => {
    const c = new AbortController();
    c.abort();
    await expect(pinnedFetch(`http://127.0.0.1:${port}/`, { allowPrivate: true, signal: c.signal })).rejects.toBeTruthy();
  });
});
