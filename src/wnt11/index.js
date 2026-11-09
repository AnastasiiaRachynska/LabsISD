"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createApiServer } = require("./api-server");
const { createApiDatabase } = require("./database");

async function startApiServer({
  databasePath = process.env.API_DATABASE_PATH ||
    path.resolve(process.cwd(), "data", "wnt11.sqlite"),
  secret = process.env.API_JWT_SECRET,
  host = process.env.HOST || "127.0.0.1",
  port = process.env.PORT === undefined ? 3000 : Number(process.env.PORT),
  logger,
  now = () => new Date(),
} = {}) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new TypeError("Set API_JWT_SECRET to a secret of at least 32 characters.");
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError("PORT must be an integer between 0 and 65535.");
  }
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }

  const database = createApiDatabase(databasePath);
  let server;
  try {
    server = createApiServer({
      database,
      secret,
      now,
      ...(logger ? { logger } : {}),
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    if (server && server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    database.close();
    throw error;
  }

  return {
    server,
    database,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      database.close();
    },
  };
}

module.exports = {
  startApiServer,
};
