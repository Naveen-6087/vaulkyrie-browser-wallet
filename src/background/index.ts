// Vaulkyrie background service worker
// Handles persistent state, network requests, and message passing

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Vaulkyrie] Extension installed");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_BALANCE") {
    // TODO: Fetch balance from Solana RPC
    sendResponse({ balance: 0 });
  }
  if (message.type === "SIGN_TRANSACTION") {
    // TODO: Threshold signing flow
    sendResponse({ error: "Not implemented" });
  }
  return true; // async response
});
