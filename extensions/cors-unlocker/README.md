# WatchParty CORS Unlocker

An optional Chrome / Edge / Brave (Manifest V3) extension for desktop. It is only
needed when a video link's **final** server sends no CORS headers, so WatchParty's
in-browser decoder (Movi) can't read it. WatchParty tells you when that's the case:
*"The video's server (host) blocks browser streaming of this format..."*.

It is not bundled into the web app, holds no tokens or secrets, and proxies nothing:
the browser still downloads the video straight from the CDN.

## What it does

One `declarativeNetRequest` session rule. For requests made **by WatchParty pages**
(`*.vercel.app`, `localhost`, `127.0.0.1`) to the listed video servers, it sets these
response headers:

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`
- `Access-Control-Allow-Headers: *`
- `Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges, Content-Type, Content-Disposition`
- `Cross-Origin-Resource-Policy: cross-origin`

Requests from any other site are untouched. A content script on WatchParty pages sets
`data-watchparty-cors-unlocker` on `<html>` so the app knows it's installed; it reads
nothing from the page.

Default video servers (subdomains included): `real-debrid.com`, `rdeb.io`,
`alldebrid.com`, `debrid.it`, `premiumize.me`, `torbox.app`, `debrid-link.com`.
Add others on the options page; Chrome asks for access to each new host.

## Install (unpacked)

1. Download this folder (`extensions/cors-unlocker`).
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn on **Developer mode** and click **Load unpacked**; pick the folder.
4. Reload the WatchParty tab.
5. If WatchParty names a server that isn't covered, open the extension's **Options**,
   add that host, and **Save**.

Phone browsers can't load extensions like this, so links whose final server blocks
CORS can't play on phones.
