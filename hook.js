// Runs in x.com's page. When X's own app loads a Following list, pass the
// users (id + handle) to the extension. Only acted on during an import.
(() => {
  const isFollowing = (url) => /\/graphql\/[^/]+\/Following\b/.test(url);

  function emit(data) {
    const users = [];
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      const name = o.core?.screen_name || o.legacy?.screen_name;
      if (o.__typename === "User" && o.rest_id && name) users.push({ id: o.rest_id, name });
      else for (const v of Object.values(o)) walk(v);
    })(data);
    if (users.length) window.postMessage({ __xsa: "following", users }, location.origin);
  }

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (_method, url) {
    if (isFollowing(String(url))) {
      this.addEventListener("load", () => {
        try { emit(this.responseType === "json" ? this.response : JSON.parse(this.responseText)); } catch {}
      });
    }
    return open.apply(this, arguments);
  };

  const fetch_ = window.fetch;
  window.fetch = async function (input, init) {
    const res = await fetch_.call(this, input, init);
    const url = typeof input === "string" ? input : input?.url;
    if (url && isFollowing(url)) res.clone().json().then(emit, () => {});
    return res;
  };
})();
