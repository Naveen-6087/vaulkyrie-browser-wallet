// Vaulkyrie content script — injects the Solana wallet provider into dApp pages

const injectProvider = () => {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("injected.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", injectProvider);
} else {
  injectProvider();
}

// Relay messages between injected script and background
window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data?.type?.startsWith("VAULKYRIE_")) {
    return;
  }
  chrome.runtime.sendMessage(event.data);
});
