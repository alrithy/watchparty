// Tells a WatchParty page that the unlocker is installed (the page reads
// document.documentElement.dataset.watchpartyCorsUnlocker). Runs only on the
// app's hosts; reads nothing from the page.
(() => {
  const host = location.hostname;
  const isApp = /^watchparty(-[a-z0-9-]+)?\.vercel\.app$/.test(host) || host === "localhost" || host === "127.0.0.1";
  if (!isApp) return;
  document.documentElement.dataset.watchpartyCorsUnlocker = chrome.runtime.getManifest().version;
  chrome.runtime.sendMessage({ type: "watchparty-hello" }).catch(() => {});
})();
