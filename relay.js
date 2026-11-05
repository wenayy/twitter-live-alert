// Forwards Following lists captured by hook.js (page world) to the background.
window.addEventListener("message", (e) => {
  if (e.source === window && e.data?.__xsa === "following") {
    chrome.runtime.sendMessage({ type: "followingBatch", users: e.data.users }).catch(() => {});
  }
});
