// e2Client.js
const E2_BASE_URL = process.env.E2_BASE_URL;
const E2_CLIENT_ID = process.env.E2_CLIENT_ID;
const E2_CLIENT_SECRET = process.env.E2_CLIENT_SECRET;
const E2_SCOPE = process.env.E2_SCOPE || "openid"; // sett tom hvis ikke brukes

if (!E2_BASE_URL || !E2_CLIENT_ID || !E2_CLIENT_SECRET) {
  console.warn("[E2] Missing env vars: E2_BASE_URL / E2_CLIENT_ID / E2_CLIENT_SECRET");
}

let cachedToken = null; // { token, expiresAt }

function basicAuthHeader(id, secret) {
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

async function requestToken(tokenPath, mode) {
  // mode: "body" | "basic"
  const body = new URLSearchParams({
    grant_type: "client_credentials",
  });

  // scope er ofte optional – slå av ved å sette E2_SCOPE=""
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
  const res = await fetch(url, { method: "POST", headers, body });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`E2 token ${tokenPath} (${mode}) ${res.status}: ${text}`);
  }

  const data = JSON.parse(text); // { access_token, expires_in, token_type, ... }
  return data;
}

async function getE2AccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAt) return cachedToken.token;

  // Prøv i prioritert rekkefølge
  const attempts = [
    { path: "/oauth2/token", mode: "basic" },
    { path: "/oauth2/token", mode: "body" },
    { path: "/idp/oauth2/token", mode: "basic" },
    { path: "/idp/oauth2/token", mode: "body" },
  ];

  let lastErr = null;

  for (const a of attempts) {
    try {
      const data = await requestToken(a.path, a.mode);

      // Refresh 60 sek før utløp
      const skewMs = 60_000;
      cachedToken = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in * 1000) - skewMs,
      };
      return cachedToken.token;
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error("E2 token request failed");
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
    cachedToken = null;
    const token2 = await getE2AccessToken();
    res = await doFetch(token2);
  }

  return res;
}

module.exports = { getE2AccessToken, e2Fetch };
