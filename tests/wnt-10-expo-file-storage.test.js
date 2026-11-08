"use strict";

const { createExpoFileStorage } = require("../src/bootstrap/expo-file-storage");

function createFileSystem() {
  return {
    documentDirectory: "file:///documents",
    writeAsStringAsync: jest.fn(async () => undefined),
    moveAsync: jest.fn(async () => undefined),
    deleteAsync: jest.fn(async () => undefined),
  };
}

describe("WNT-10 Expo device-local file storage", () => {
  test("requires an ID factory", () => {
    expect(() => createExpoFileStorage()).toThrow("requires an ID factory");
  });

  test("writes UTF-8 content to a temporary file before publishing a .txt export", async () => {
    const fileSystem = createFileSystem();
    const storage = createExpoFileStorage({
      fileSystem,
      createId: () => "unique-export-id",
    });

    const result = await storage.writeTextFile({
      fileName: "entry-entry-1.txt",
      contents: "Café 東京",
      encoding: "utf8",
    });

    expect(fileSystem.writeAsStringAsync).toHaveBeenCalledWith(
      "file:///documents/.unique-export-id.tmp",
      "Café 東京",
      { encoding: "utf8" },
    );
    expect(fileSystem.moveAsync).toHaveBeenCalledWith({
      from: "file:///documents/.unique-export-id.tmp",
      to: "file:///documents/entry-entry-1-unique-export-id.txt",
    });
    expect(fileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(result.uri).toBe("file:///documents/entry-entry-1-unique-export-id.txt");
  });

  test("removes a partial temporary file and propagates a write failure", async () => {
    const writeError = new Error("Write failed.");
    const fileSystem = createFileSystem();
    fileSystem.writeAsStringAsync.mockRejectedValue(writeError);
    const storage = createExpoFileStorage({
      fileSystem,
      createId: () => "unique-export-id",
    });

    await expect(
      storage.writeTextFile({
        fileName: "entry-entry-1.txt",
        contents: "Content",
        encoding: "utf8",
      }),
    ).rejects.toBe(writeError);

    expect(fileSystem.moveAsync).not.toHaveBeenCalled();
    expect(fileSystem.deleteAsync).toHaveBeenCalledWith(
      "file:///documents/.unique-export-id.tmp",
      { idempotent: true },
    );
  });

  test("rejects unsafe file names without writing to device storage", async () => {
    const fileSystem = createFileSystem();
    const storage = createExpoFileStorage({
      fileSystem,
      createId: () => "unique-export-id",
    });

    await expect(
      storage.writeTextFile({
        fileName: "../private.txt",
        contents: "Content",
        encoding: "utf8",
      }),
    ).rejects.toThrow("safe .txt file name");

    expect(fileSystem.writeAsStringAsync).not.toHaveBeenCalled();
  });

  test("rejects non-UTF-8 data and unavailable device storage", async () => {
    const fileSystem = createFileSystem();
    const storage = createExpoFileStorage({
      fileSystem,
      createId: () => "unique-export-id",
    });

    await expect(
      storage.writeTextFile({
        fileName: "entry-entry-1.txt",
        contents: "Content",
        encoding: "base64",
      }),
    ).rejects.toThrow("requires UTF-8");
    expect(fileSystem.writeAsStringAsync).not.toHaveBeenCalled();

    const unavailableStorage = createExpoFileStorage({
      fileSystem: { documentDirectory: null },
      createId: () => "unique-export-id",
    });
    await expect(
      unavailableStorage.writeTextFile({
        fileName: "entry-entry-1.txt",
        contents: "Content",
        encoding: "utf8",
      }),
    ).rejects.toThrow("device-local document storage is unavailable");
  });

  test("rejects an unsafe generated ID before touching the filesystem", async () => {
    const fileSystem = createFileSystem();
    const storage = createExpoFileStorage({
      fileSystem,
      createId: () => "../unsafe",
    });

    await expect(
      storage.writeTextFile({
        fileName: "entry-entry-1.txt",
        contents: "Content",
        encoding: "utf8",
      }),
    ).rejects.toThrow("safe file identifier");
    expect(fileSystem.writeAsStringAsync).not.toHaveBeenCalled();
  });

  test("reports failures to clean up temporary files instead of hiding them", async () => {
    const writeError = new Error("Write failed.");
    const cleanupError = new Error("Cleanup failed.");
    const fileSystem = createFileSystem();
    fileSystem.writeAsStringAsync.mockRejectedValue(writeError);
    fileSystem.deleteAsync.mockRejectedValue(cleanupError);
    const storage = createExpoFileStorage({
      fileSystem,
      createId: () => "unique-export-id",
    });

    await expect(
      storage.writeTextFile({
        fileName: "entry-entry-1.txt",
        contents: "Content",
        encoding: "utf8",
      }),
    ).rejects.toMatchObject({
      errors: [writeError, cleanupError],
      message: "Export failed and its temporary file could not be removed.",
    });
  });
});
