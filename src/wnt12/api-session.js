"use strict";

const BASE_URL_KEY = "labsisd.api.baseUrl";
const CREDENTIALS_KEY = "labsisd.api.credentials";

function requireSecureStore(secureStore) {
  const methods = ["getItemAsync", "setItemAsync", "deleteItemAsync"];
  if (!secureStore || methods.some((method) => typeof secureStore[method] !== "function")) {
    throw new TypeError("API session requires a secure key-value store.");
  }
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("API base URL must be a nonblank HTTP or HTTPS URL.");
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TypeError("API base URL must be a valid HTTP or HTTPS URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("API base URL must use HTTP or HTTPS and must not contain credentials, query, or fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

function parseTokenResponse(body, now) {
  if (
    !body ||
    body.tokenType !== "Bearer" ||
    typeof body.accessToken !== "string" ||
    body.accessToken.length === 0 ||
    typeof body.refreshToken !== "string" ||
    body.refreshToken.length === 0 ||
    !Number.isInteger(body.accessTokenExpiresIn) ||
    body.accessTokenExpiresIn < 1 ||
    !body.user ||
    typeof body.user.userId !== "string" ||
    typeof body.user.email !== "string"
  ) {
    throw new TypeError("Authentication API returned an invalid token response.");
  }
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    accessTokenExpiresAt: now() + body.accessTokenExpiresIn * 1000,
    user: body.user,
  };
}

/**
 * @param {{
 *   secureStore: {
 *     getItemAsync: (key: string) => Promise<string | null>,
 *     setItemAsync: (key: string, value: string) => Promise<void>,
 *     deleteItemAsync: (key: string) => Promise<void>
 *   },
 *   fetchImpl?: typeof fetch,
 *   now?: () => number
 * }} options
 */
function createApiSession({ secureStore, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  requireSecureStore(secureStore);
  if (typeof fetchImpl !== "function") {
    throw new TypeError("API session requires a fetch implementation.");
  }
  if (typeof now !== "function") {
    throw new TypeError("API session requires a clock function.");
  }

  let baseUrl;
  let credentials;
  let refreshPromise;

  async function saveCredentials(next) {
    credentials = next;
    await secureStore.setItemAsync(CREDENTIALS_KEY, JSON.stringify(next));
  }

  async function request(path, { method = "GET", body, accessToken } = {}) {
    if (!baseUrl) {
      throw new Error("Set the API base URL before using account services.");
    }
    const response = await fetchImpl(`${baseUrl}/api/v1/${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let responseBody = null;
    if (text.length > 0) {
      try {
        responseBody = JSON.parse(text);
      } catch (error) {
        throw new Error(`API returned invalid JSON: ${error.message}`);
      }
    }
    if (!response.ok) {
      const error = new Error(
        responseBody && responseBody.detail
          ? responseBody.detail
          : `API request failed with HTTP ${response.status}.`,
      );
      error.status = response.status;
      error.code = responseBody && responseBody.code;
      error.body = responseBody;
      throw error;
    }
    return responseBody;
  }

  async function refreshAccessToken() {
    if (!credentials) {
      throw new Error("Sign in is required before synchronization.");
    }
    if (refreshPromise) {
      return refreshPromise;
    }
    refreshPromise = (async () => {
      try {
        const body = await request("auth/refresh", {
          method: "POST",
          body: { refreshToken: credentials.refreshToken },
        });
        const refreshed = parseTokenResponse(body, now);
        await saveCredentials(refreshed);
        return refreshed.accessToken;
      } catch (error) {
        if (error && error.status === 401) {
          credentials = undefined;
          await secureStore.deleteItemAsync(CREDENTIALS_KEY);
        }
        throw error;
      } finally {
        refreshPromise = undefined;
      }
    })();
    return refreshPromise;
  }

  async function authenticate(path, email, password) {
    if (typeof email !== "string" || email.trim().length === 0) {
      throw new TypeError("Email must be a nonblank string.");
    }
    if (typeof password !== "string" || password.length < 8) {
      throw new TypeError("Password must contain at least 8 characters.");
    }
    const body = await request(path, {
      method: "POST",
      body: { email: email.trim(), password },
    });
    const next = parseTokenResponse(body, now);
    await saveCredentials(next);
    return next.user;
  }

  return {
    async restore() {
      const [savedBaseUrl, savedCredentials] = await Promise.all([
        secureStore.getItemAsync(BASE_URL_KEY),
        secureStore.getItemAsync(CREDENTIALS_KEY),
      ]);
      baseUrl = savedBaseUrl ? normalizeBaseUrl(savedBaseUrl) : undefined;
      if (savedCredentials) {
        let parsed;
        try {
          parsed = JSON.parse(savedCredentials);
        } catch (error) {
          throw new Error(`Saved API credentials are invalid JSON: ${error.message}`);
        }
        if (
          !parsed ||
          typeof parsed.accessToken !== "string" ||
          typeof parsed.refreshToken !== "string" ||
          !Number.isFinite(parsed.accessTokenExpiresAt) ||
          !parsed.user
        ) {
          throw new TypeError("Saved API credentials have an invalid shape.");
        }
        credentials = parsed;
      }
      return {
        baseUrl: baseUrl || "",
        user: credentials ? credentials.user : null,
      };
    },
    async setBaseUrl(value) {
      const normalized = normalizeBaseUrl(value);
      await secureStore.setItemAsync(BASE_URL_KEY, normalized);
      baseUrl = normalized;
      return normalized;
    },
    getBaseUrl() {
      return baseUrl || "";
    },
    getUser() {
      return credentials ? credentials.user : null;
    },
    async register(email, password) {
      if (typeof email !== "string" || email.trim().length === 0) {
        throw new TypeError("Email must be a nonblank string.");
      }
      if (typeof password !== "string" || password.length < 8) {
        throw new TypeError("Password must contain at least 8 characters.");
      }
      await request("auth/register", {
        method: "POST",
        body: { email: email.trim(), password },
      });
      return authenticate("auth/login", email, password);
    },
    login(email, password) {
      return authenticate("auth/login", email, password);
    },
    async getAccessToken() {
      if (!credentials) {
        throw new Error("Sign in is required before synchronization.");
      }
      if (credentials.accessTokenExpiresAt <= now() + 30_000) {
        return refreshAccessToken();
      }
      return credentials.accessToken;
    },
    async logout() {
      credentials = undefined;
      await secureStore.deleteItemAsync(CREDENTIALS_KEY);
    },
  };
}

module.exports = {
  createApiSession,
  normalizeBaseUrl,
};
