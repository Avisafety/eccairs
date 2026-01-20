// e2Client.js
// ECCAIRS E2 OAuth2 Client - Multi-tenant support
// Lokalt referanse - deploy til Fly.io

// Fallback til globale env-variabler (brukes hvis ingen per-selskap credentials)
const GLOBAL_E2_BASE_URL = process.env.E2_BASE_URL;
const GLOBAL_E2_CLIENT_ID = process.env.E2_CLIENT_ID;
const GLOBAL_E2_CLIENT_SECRET = process.env.E2_CLIENT_SECRET;
// Do not default to "openid"; many client_credentials setups expect no scope or a tenant-specific scope.
const GLOBAL_E2_SCOPE = process.env.E2_SCOPE ? String(process.env.E2_SCOPE).trim() : "";

if (!GLOBAL_E2_BASE_URL || !GLOBAL_E2_CLIENT_ID || !GLOBAL_E2_CLIENT_SECRET) {
  console.warn("[E2] Missing global env vars: E2_BASE_URL / E2_CLIENT_ID / E2_CLIENT_SECRET - will require per-company credentials");
}

// Token cache per company (eller 'global' for fallback)
const tokenCache = new Map();

function basicAuthHeader(id, secret) {
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

async function requestToken({ baseUrl, clientId, clientSecret, scope }, tokenPath, mode) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
  });
  if (scope) body.set("scope", scope);

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (mode === "body") {
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
  } else if (mode === "basic") {
    headers.Authorization = basicAuthHeader(clientId, clientSecret);
  }

  const url = `${baseUrl}${tokenPath}`;
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

/**
 * Get E2 access token - supports per-company credentials
 * @param {Object} integration - Optional integration object with e2_client_id, e2_client_secret, e2_base_url, e2_scope
 * @returns {Promise<string>} Access token
 */
async function getE2AccessToken(integration = null) {
  // Determine which credentials to use
  const clientId = integration?.e2_client_id || GLOBAL_E2_CLIENT_ID;
  const clientSecret = integration?.e2_client_secret || GLOBAL_E2_CLIENT_SECRET;
  const baseUrl = integration?.e2_base_url || GLOBAL_E2_BASE_URL;
  // Preserve empty-string scope (meaning: don't send `scope`), but fall back when it's null/undefined.
  const scope = integration?.e2_scope ?? GLOBAL_E2_SCOPE;

  if (!clientId || !clientSecret || !baseUrl) {
    throw new Error("E2 credentials not configured (neither per-company nor global)");
  }

  // Use company_id as cache key, or 'global' for fallback
  const cacheKey = integration?.company_id || "global";
  const now = Date.now();
  
  const cached = tokenCache.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    return cached.token;
  }

  // Token attempts with preferred order
  // Prefer the documented IdP token endpoint. Avoid falling back to /oauth2/token
  // because it often returns maintenance/WAF HTML, which hides the real OAuth error.
  const attempts = [
    { path: "/idp/oauth2/token", mode: "body" },
    { path: "/idp/oauth2/token", mode: "basic" },
  ];

  let lastErr = null;
  const errors = [];

  for (const a of attempts) {
    try {
      const data = await requestToken({ baseUrl, clientId, clientSecret, scope }, a.path, a.mode);
      console.log(`[E2] Token obtained successfully via ${a.path} (${a.mode}) for ${cacheKey}`);
      
      const skewMs = 60_000;
      tokenCache.set(cacheKey, {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in * 1000) - skewMs,
      });
      
      return data.access_token;
    } catch (err) {
      console.warn(`[E2] Attempt ${a.path} (${a.mode}) failed: ${err.message}`);
      errors.push(`${a.path} (${a.mode}): ${err.message}`);
      lastErr = err;
    }
  }

  console.error("[E2] All token attempts failed:", errors);
  throw lastErr || new Error("E2 token request failed - all attempts exhausted");
}

/**
 * Clear cached token for a company (call after credential update)
 * @param {string} companyId 
 */
function clearTokenCache(companyId = "global") {
  tokenCache.delete(companyId);
  console.log(`[E2] Token cache cleared for ${companyId}`);
}

/**
 * Make authenticated E2 API call with auto-refresh
 * @param {string} path - API path
 * @param {Object} init - fetch options
 * @param {Object} integration - Optional integration object
 */
async function e2Fetch(path, init = {}, integration = null) {
  const baseUrl = integration?.e2_base_url || GLOBAL_E2_BASE_URL;
  const token = await getE2AccessToken(integration);
  
  const doFetch = async (tok) =>
    fetch(`${baseUrl}${path}`, {
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
    const cacheKey = integration?.company_id || "global";
    tokenCache.delete(cacheKey);
    const token2 = await getE2AccessToken(integration);
    res = await doFetch(token2);
  }
  
  return res;
}

module.exports = { getE2AccessToken, e2Fetch, clearTokenCache };
