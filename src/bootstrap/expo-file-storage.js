"use strict";

function requireSafeFileName(fileName) {
  if (
    typeof fileName !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.txt$/.test(fileName)
  ) {
    throw new TypeError("Export file name must be a safe .txt file name.");
  }
}

function createExpoFileStorage({ fileSystem, createId } = {}) {
  if (typeof createId !== "function") {
    throw new TypeError("Expo file storage requires an ID factory.");
  }

  return {
    async writeTextFile({ fileName, contents, encoding }) {
      requireSafeFileName(fileName);
      if (typeof contents !== "string" || encoding !== "utf8") {
        throw new TypeError("Expo file storage requires UTF-8 text contents.");
      }

      const fileSystemApi = fileSystem || require("expo-file-system/legacy");
      if (
        typeof fileSystemApi.documentDirectory !== "string" ||
        typeof fileSystemApi.writeAsStringAsync !== "function" ||
        typeof fileSystemApi.moveAsync !== "function" ||
        typeof fileSystemApi.deleteAsync !== "function"
      ) {
        throw new Error("Expo device-local document storage is unavailable.");
      }

      const uniqueId = createId();
      if (typeof uniqueId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(uniqueId)) {
        throw new TypeError("Export ID factory must return a safe file identifier.");
      }
      const directory = fileSystemApi.documentDirectory.endsWith("/")
        ? fileSystemApi.documentDirectory
        : `${fileSystemApi.documentDirectory}/`;
      const completedFileName = `${fileName.slice(0, -4)}-${uniqueId}.txt`;
      const temporaryUri = `${directory}.${uniqueId}.tmp`;
      const completedUri = `${directory}${completedFileName}`;

      try {
        await fileSystemApi.writeAsStringAsync(temporaryUri, contents, { encoding: "utf8" });
        await fileSystemApi.moveAsync({ from: temporaryUri, to: completedUri });
      } catch (error) {
        try {
          await fileSystemApi.deleteAsync(temporaryUri, { idempotent: true });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Export failed and its temporary file could not be removed.",
          );
        }
        throw error;
      }

      return { uri: completedUri };
    },
  };
}

module.exports = {
  createExpoFileStorage,
};
