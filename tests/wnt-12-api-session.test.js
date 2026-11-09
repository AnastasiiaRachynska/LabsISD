"use strict";

const { createApiSession, normalizeBaseUrl } = require("../src/wnt12/api-session");

function createSecureStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItemAsync: jest.fn(async (key) => values.get(key) || null),
    setItemAsync: jest.fn(async (key, value) => values.set(key, value)),
    deleteItemAsync: jest.fn(async (key) => values.delete(key)),
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe("WNT-12 persisted API session", () => {
  test("requires secure storage, fetch, and a valid clock", () => {
    expect(() => createApiSession()).toThrow("secure key-value store");
    expect(() => createApiSession({ secureStore: {} })).toThrow("secure key-value store");
    const secureStore = createSecureStore();
    expect(() => createApiSession({ secureStore, fetchImpl: null })).toThrow("fetch implementation");
    expect(() => createApiSession({ secureStore, now: 1 })).toThrow("clock function");
  });

  test("normalizes API URLs and rejects malformed or unsafe URL forms", () => {
    expect(normalizeBaseUrl(" https://api.example.test/// ")).toBe("https://api.example.test");
    for (const value of [
      "",
      "not-a-url",
      "ftp://api.example.test",
      "https://user:pass@api.example.test",
      "https://api.example.test?token=secret",
    ]) {
      expect(() => normalizeBaseUrl(value)).toThrow();
    }
  });

  test("validates credentials and reports API URL, transport, JSON, and HTTP errors", async () => {
    const secureStore = createSecureStore();
    const session = createApiSession({ secureStore });
    await expect(session.login("", "Password123")).rejects.toThrow("Email must be a nonblank string");
    await expect(session.register("writer@example.test", "short")).rejects.toThrow(
      "Password must contain at least 8 characters",
    );
    await expect(session.login("writer@example.test", "Password123")).rejects.toThrow(
      "Set the API base URL",
    );

    await session.setBaseUrl("https://api.example.test");
    const invalidJsonSession = createApiSession({
      secureStore,
      fetchImpl: async () => ({ status: 200, ok: true, text: async () => "{" }),
    });
    await invalidJsonSession.setBaseUrl("https://api.example.test");
    await expect(invalidJsonSession.login("writer@example.test", "Password123"))
      .rejects.toThrow("API returned invalid JSON");

    const failedSession = createApiSession({
      secureStore,
      fetchImpl: async () => ({
        status: 503,
        ok: false,
        text: async () => JSON.stringify({ code: "UNAVAILABLE" }),
      }),
    });
    await failedSession.setBaseUrl("https://api.example.test");
    await expect(failedSession.login("writer@example.test", "Password123"))
      .rejects.toMatchObject({ status: 503, code: "UNAVAILABLE" });
  });

  test.each([
    [{}, "invalid token response"],
    [{ tokenType: "Bearer" }, "invalid token response"],
    [{
      tokenType: "Bearer",
      accessToken: "access",
      refreshToken: "refresh",
      accessTokenExpiresIn: 0,
      user: { userId: "user-1", email: "writer@example.test" },
    }, "invalid token response"],
  ])("rejects malformed authentication response %#", async (body, message) => {
    const secureStore = createSecureStore();
    const session = createApiSession({
      secureStore,
      fetchImpl: async () => jsonResponse(200, body),
    });
    await session.setBaseUrl("https://api.example.test");
    await expect(session.login("writer@example.test", "Password123")).rejects.toThrow(message);
  });

  test.each([
    ["{", "invalid JSON"],
    [JSON.stringify({ accessToken: "only-access" }), "invalid shape"],
  ])("rejects malformed saved credentials", async (savedCredentials, message) => {
    const session = createApiSession({
      secureStore: createSecureStore({
        "labsisd.api.baseUrl": "https://api.example.test",
        "labsisd.api.credentials": savedCredentials,
      }),
    });
    await expect(session.restore()).rejects.toThrow(message);
  });

  test("registers, signs in, restores secure credentials, and logs out without deleting URL", async () => {
    const secureStore = createSecureStore();
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse(201, {
        user: { userId: "user-1", email: "writer@example.test", createdAt: "2026-01-01T00:00:00.000Z" },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        tokenType: "Bearer",
        accessToken: "access-1",
        accessTokenExpiresIn: 900,
        refreshToken: "refresh-1",
        user: { userId: "user-1", email: "writer@example.test" },
      }));
    const session = createApiSession({ secureStore, fetchImpl, now: () => 1000 });
    await session.setBaseUrl("http://127.0.0.1:3000/");
    const user = await session.register("writer@example.test", "Password123");
    expect(user.email).toBe("writer@example.test");
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3000/api/v1/auth/register",
      "http://127.0.0.1:3000/api/v1/auth/login",
    ]);
    expect(secureStore.values.get("labsisd.api.credentials")).toContain("refresh-1");

    const restored = createApiSession({ secureStore, fetchImpl, now: () => 2000 });
    await expect(restored.restore()).resolves.toMatchObject({
      baseUrl: "http://127.0.0.1:3000",
      user: { userId: "user-1" },
    });
    await restored.logout();
    await expect(restored.getAccessToken()).rejects.toThrow("Sign in is required");
    expect(await restored.getBaseUrl()).toBe("http://127.0.0.1:3000");
  });

  test("refreshes expiring access tokens once and persists rotated refresh credentials", async () => {
    const secureStore = createSecureStore({
      "labsisd.api.baseUrl": "https://api.example.test",
      "labsisd.api.credentials": JSON.stringify({
        accessToken: "expired-access",
        refreshToken: "refresh-old",
        accessTokenExpiresAt: 10_000,
        user: { userId: "user-1", email: "writer@example.test" },
      }),
    });
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, {
      tokenType: "Bearer",
      accessToken: "access-new",
      accessTokenExpiresIn: 900,
      refreshToken: "refresh-new",
      user: { userId: "user-1", email: "writer@example.test" },
    }));
    const session = createApiSession({ secureStore, fetchImpl, now: () => 20_000 });
    await session.restore();
    await expect(Promise.all([
      session.getAccessToken(),
      session.getAccessToken(),
    ])).resolves.toEqual(["access-new", "access-new"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(secureStore.values.get("labsisd.api.credentials")).refreshToken)
      .toBe("refresh-new");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/auth/refresh",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ refreshToken: "refresh-old" }),
      }),
    );
  });

  test("clears credentials after an invalid refresh token and propagates transport errors", async () => {
    const secureStore = createSecureStore({
      "labsisd.api.baseUrl": "https://api.example.test",
      "labsisd.api.credentials": JSON.stringify({
        accessToken: "expired-access",
        refreshToken: "invalid-refresh",
        accessTokenExpiresAt: 0,
        user: { userId: "user-1", email: "writer@example.test" },
      }),
    });
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(401, {
      status: 401,
      code: "INVALID_REFRESH_TOKEN",
      detail: "Refresh token expired.",
    }));
    const session = createApiSession({ secureStore, fetchImpl });
    await session.restore();
    await expect(session.getAccessToken()).rejects.toMatchObject({ status: 401 });
    expect(secureStore.values.has("labsisd.api.credentials")).toBe(false);
  });

  test("retains credentials when refresh fails for a non-authentication reason", async () => {
    const savedCredentials = JSON.stringify({
      accessToken: "expired-access",
      refreshToken: "refresh",
      accessTokenExpiresAt: 0,
      user: { userId: "user-1", email: "writer@example.test" },
    });
    const secureStore = createSecureStore({
      "labsisd.api.baseUrl": "https://api.example.test",
      "labsisd.api.credentials": savedCredentials,
    });
    const session = createApiSession({
      secureStore,
      fetchImpl: async () => jsonResponse(503, { detail: "Server unavailable." }),
    });
    await session.restore();
    await expect(session.getAccessToken()).rejects.toMatchObject({ status: 503 });
    expect(secureStore.values.get("labsisd.api.credentials")).toBe(savedCredentials);
  });
});
