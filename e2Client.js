// e2Client.js
const E2_BASE_URL = process.env.E2_BASE_URL;
const E2_CLIENT_ID = process.env.E2_CLIENT_ID;
const E2_CLIENT_SECRET = process.env.E2_CLIENT_SECRET;

if (!E2_BASE_URL || !E2_CLIENT_ID || !E2_CLIENT_SECRET) {
  // Ikke kræsje ved import i dev hvis du vil, men dette er tryggest i prod
  console.warn("[E2] Missing env vars: E2_BASE_URL / E2_CLIENT_ID / E2_CLIENT_SECRET");
}

let cachedToken = null; // { token, expiresAt }

async function getE2AccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAt) return cachedToken.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: E2_CLIENT_ID,
    client_secret: E2_CLIENT_SECRET,
    // scope: "openid", // slå på hvis E2 krever det
  });

  const res = await fetch(`${E2_BASE_URL}/idp/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`E2 token error ${res.status}: ${text}`);
  }

  const data = await res.json(); // { access_token, expires_in, token_type, ... }

  // Refresh 60 sek før utløp
  const skewMs = 60_000;
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000) - skewMs,
  };

  return cachedToken.token;
}

async function e2Fetch(path, init = {}) {
  const token = await getE2AccessToken();

  const doFetch = async (tok) => {
    return fetch(`${E2_BASE_URL}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.headers || {}),
        Authorization: `Bearer ${tok}`,
      },
    });
  };

  let res = await doFetch(token);

  // Token kan være utløpt/invalid – hent ny og retry én gang
  if (res.status === 401) {
    cachedToken = null;
    const token2 = await getE2AccessToken();
    res = await doFetch(token2);
  }

  return res;
}

module.exports = { getE2AccessToken, e2Fetch };
