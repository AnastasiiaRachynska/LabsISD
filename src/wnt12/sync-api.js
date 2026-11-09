"use strict";

/**
 * @param {{
 *   baseUrl?: string,
 *   getBaseUrl?: () => string | Promise<string>,
 *   getAccessToken: () => string | Promise<string>,
 *   fetchImpl?: typeof fetch
 * }} options
 */
function createSyncApi({ baseUrl, getBaseUrl, getAccessToken, fetchImpl = globalThis.fetch } = {}) {
  if (
    (typeof baseUrl !== "string" || baseUrl.trim().length === 0) &&
    typeof getBaseUrl !== "function"
  ) {
    throw new TypeError("Sync API requires a nonblank base URL.");
  }
  if (typeof getAccessToken !== "function") {
    throw new TypeError("Sync API requires an access-token provider.");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Sync API requires a fetch implementation.");
  }
  async function request(path, options = {}) {
    const configuredBaseUrl = typeof getBaseUrl === "function" ? await getBaseUrl() : baseUrl;
    if (typeof configuredBaseUrl !== "string" || configuredBaseUrl.trim().length === 0) {
      throw new Error("Synchronization requires a configured API base URL.");
    }
    const token = await getAccessToken();
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new Error("Synchronization requires a valid access token.");
    }
    const root = configuredBaseUrl.replace(/\/+$/, "");
    const response = await fetchImpl(`${root}/api/v1/sync/${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let body = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch (error) {
        throw new Error(`Sync API returned invalid JSON: ${error.message}`);
      }
    }
    return { status: response.status, body };
  }

  return {
    async pushChanges(payload, { idempotencyKey } = {}) {
      if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
        throw new TypeError("Push changes requires an idempotency key.");
      }
      return request("push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
    },
    async pullChanges(cursor) {
      const query = cursor === null || cursor === undefined
        ? ""
        : `?cursor=${encodeURIComponent(cursor)}`;
      return request(`pull${query}`, { method: "GET" });
    },
  };
}

module.exports = {
  createSyncApi,
};
