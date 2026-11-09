"use strict";

const { startApiServer } = require("./index");

startApiServer()
  .then(({ server, close }) => {
    const address = server.address();
    console.info(JSON.stringify({
      event: "api.server.started",
      host: address.address,
      port: address.port,
    }));
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      close().then(
        () => console.info(JSON.stringify({ event: "api.server.stopped" })),
        (error) => {
          console.error("WNT-11 API shutdown failed:", error);
          process.exitCode = 1;
        },
      );
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  })
  .catch((error) => {
    console.error("WNT-11 API startup failed:", error);
    process.exitCode = 1;
  });
