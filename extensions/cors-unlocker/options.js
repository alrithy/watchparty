import { DEFAULT_CDN_DOMAINS, cdnDomains, cleanDomain } from "./shared.js";

const box = document.getElementById("domains");
const status = document.getElementById("status");

async function show() {
  box.value = (await cdnDomains()).join("\n");
}

async function save(list) {
  const domains = [...new Set(list.map(cleanDomain).filter(Boolean))];
  // Chrome only prompts for hosts the extension doesn't have yet.
  // "*." also matches the bare domain.
  const granted = await chrome.permissions.request({ origins: domains.map((d) => `https://*.${d}/*`) });
  if (!granted) {
    status.textContent = "Not saved: permission was declined.";
    return;
  }
  await chrome.storage.local.set({ cdnDomains: domains });
  status.textContent = "Saved.";
  await show();
}

document.getElementById("save").onclick = () => void save(box.value.split(/\s+/));
document.getElementById("reset").onclick = () => void save(DEFAULT_CDN_DOMAINS);
void show();
