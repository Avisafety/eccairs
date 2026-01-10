// e2Client.js

const E2_BASE_URL = process.env.E2_BASE_URL;
const E2_CLIENT_ID = process.env.E2_CLIENT_ID;
const E2_CLIENT_SECRET = process.env.E2_CLIENT_SECRET;
const E2_SCOPE = process.env.E2_SCOPE || "openid";

if (!E2_BASE_URL || !E2_CLIENT_ID || !E2_CLIENT_SECRET) {
  console.warn("[E2] Missing env vars: E2_BASE_URL / E2_CLIENT_ID / E2_CLIENT_SECRET");
}

let cachedToken = null;

function basicAuthHeader(id, secret) {
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

async function requestToken(tokenPath, mode) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
  });

  if (E2_SCOPE) body.set("scope", E2_SCOPE);

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (mode === "body") {
    body.set("client_id", E2_CLIENT_ID);
    body.set("client_secret", E2_CLIENT_SECRET);
  } else if (mode === "basic") {
    headers.Authorization = basicAuthHeader(E2_CLIENT_ID, E2_CLIENT_SECRET);
  }

  const url = `${E2_BASE_URL}${tokenPath}`;
  console.log(`[E2] Token request: ${url} (mode: ${mode})`);

  const res = await fetch(url, { method: "POST", headers, body });
  const text = await res.text();
  const contentType = res.headers.get("content-type") || "";

  console.log(`[E2] Token response: status=${res.status}, content-type=${contentType}`);

  // Detect HTML response (common when hitting wrong endpoint or WAF)
  if (text.startsWith("<!DOCTYPE") || text.startsWith("<html") || text.includes("<html")) {
    console.error(`[E2] Token endpoint returned HTML instead of JSON`);
    console.error(`[E2] HTML preview: ${text.substring(0, 300)}`);
    throw new Error(`Token endpoint ${tokenPath} returned HTML (status ${res.status}). Check URL and IP whitelist.`);
  }

  if (!res.ok) {
    throw new Error(`E2 token ${tokenPath} (${mode}) ${res.status}: ${text}`);
  }

  // Verify content-type is JSON
  if (!contentType.includes("application/json")) {
    console.warn(`[E2] Unexpected content-type: ${contentType}`);
  }

  const data = JSON.parse(text);
  return data;
}

async function getE2AccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAt) return cachedToken.token;

  // Prioriter /idp/oauth2/token først (korrekt ifølge ECCAIRS API Guide v4.26)
  const attempts = [
    { path: "/idp/oauth2/token", mode: "body" },   // Most likely correct
    { path: "/idp/oauth2/token", mode: "basic" },
    { path: "/oauth2/token", mode: "body" },       // Fallback
    { path: "/oauth2/token", mode: "basic" },
  ];

  let lastErr = null;
  const errors = [];

  for (const a of attempts) {
    try {
      const data = await requestToken(a.path, a.mode);
      console.log(`[E2] Token obtained successfully via ${a.path} (${a.mode})`);

      const skewMs = 60_000;
      cachedToken = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in * 1000) - skewMs,
      };
      return cachedToken.token;
    } catch (err) {
      console.warn(`[E2] Attempt ${a.path} (${a.mode}) failed: ${err.message}`);
      errors.push(`${a.path} (${a.mode}): ${err.message}`);
      lastErr = err;
    }
  }

  console.error("[E2] All token attempts failed:", errors);
  throw lastErr || new Error("E2 token request failed - all attempts exhausted");
}

async function e2Fetch(path, init = {}) {
  const token = await getE2AccessToken();

  const doFetch = async (tok) =>
    fetch(`${E2_BASE_URL}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.headers || {}),
        Authorization: `Bearer ${tok}`,
      },
    });

  let res = await doFetch(token);

  if (res.status === 401) {
    console.log("[E2] Got 401, refreshing token...");
    cachedToken = null;
    const token2 = await getE2AccessToken();
    res = await doFetch(token2);
  }

  return res;
}

module.exports = { getE2AccessToken, e2Fetch };
