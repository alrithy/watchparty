import { APP_DOMAINS, cdnDomains } from "./shared.js";

// One session rule: responses from the listed video servers, to requests made by
// WatchParty pages, get the CORS headers a browser needs to let the page read
// them with Range requests. Nothing is proxied, stored or logged; no tokens.
const RULE_ID = 1;

async function applyRules() {
  const domains = await cdnDomains();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
            { header: "Access-Control-Allow-Methods", operation: "set", value: "GET, HEAD, OPTIONS" },
            { header: "Access-Control-Allow-Headers", operation: "set", value: "*" },
            {
              header: "Access-Control-Expose-Headers",
              operation: "set",
              value: "Content-Range, Content-Length, Accept-Ranges, Content-Type, Content-Disposition",
            },
            { header: "Cross-Origin-Resource-Policy", operation: "set", value: "cross-origin" },
          ],
        },
        condition: {
          initiatorDomains: APP_DOMAINS,
          requestDomains: domains,
          resourceTypes: ["xmlhttprequest", "media", "other"],
        },
      },
    ],
  });
}

chrome.runtime.onInstalled.addListener(applyRules);
chrome.runtime.onStartup.addListener(applyRules);
chrome.storage.onChanged.addListener((changes) => {
  if (changes.cdnDomains) void applyRules();
});
// Session rules are cleared when the browser restarts; the content script pings on each app page load.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "watchparty-hello") {
    applyRules().then(() => reply({ ok: true }), () => reply({ ok: false }));
    return true;
  }
});
