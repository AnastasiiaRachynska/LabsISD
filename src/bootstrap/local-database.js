"use strict";

const SCHEMA_VERSION = 2;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY NOT NULL,
    content TEXT NOT NULL CHECK (length(trim(content)) > 0),
    title TEXT,
    display_title TEXT NOT NULL,
    entry_type TEXT NOT NULL CHECK (
      entry_type IN (
        'Character',
        'Scene',
        'Plot Idea',
        'World-building',
        'Dialogue/Phrase',
        'General Note'
      )
    ),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS chapters_book_id_idx ON chapters(book_id);

  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) > 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS entry_tags (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (entry_id, tag_id)
  );
  CREATE INDEX IF NOT EXISTS entry_tags_tag_id_idx ON entry_tags(tag_id);

  CREATE TABLE IF NOT EXISTS entry_books (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('direct', 'chapter-derived')),
    PRIMARY KEY (entry_id, book_id, source)
  );
  CREATE INDEX IF NOT EXISTS entry_books_book_id_idx ON entry_books(book_id);

  CREATE TABLE IF NOT EXISTS entry_chapters (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    PRIMARY KEY (entry_id, chapter_id)
  );
  CREATE INDEX IF NOT EXISTS entry_chapters_chapter_id_idx ON entry_chapters(chapter_id);

  CREATE TABLE IF NOT EXISTS entry_links (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    linked_entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    CHECK (entry_id < linked_entry_id),
    PRIMARY KEY (entry_id, linked_entry_id)
  );
  CREATE INDEX IF NOT EXISTS entry_links_linked_entry_id_idx ON entry_links(linked_entry_id);

  CREATE TABLE IF NOT EXISTS pending_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS pending_changes_order_idx ON pending_changes(id);

  CREATE TABLE IF NOT EXISTS sync_metadata (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS diagnostic_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );
`;

async function initializeLocalDatabase(database) {
  if (
    !database ||
    typeof database.execAsync !== "function" ||
    typeof database.runAsync !== "function" ||
    typeof database.getFirstAsync !== "function" ||
    typeof database.withTransactionAsync !== "function"
  ) {
    throw new TypeError("A valid Expo SQLite database connection is required.");
  }

  await database.execAsync("PRAGMA foreign_keys = ON;");
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);

  const versionRecord = await database.getFirstAsync(
    "SELECT value FROM app_metadata WHERE key = ?;",
    "schema_version",
  );
  const currentVersion = versionRecord ? Number(versionRecord.value) : 0;
  if (!Number.isInteger(currentVersion) || currentVersion < 0) {
    throw new Error("The local database schema version is invalid.");
  }
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      `The local database schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}.`,
    );
  }

  await database.withTransactionAsync(async () => {
    if (currentVersion < 2) {
      await database.execAsync(SCHEMA_SQL);
    }
    await database.runAsync(
      "INSERT OR REPLACE INTO app_metadata (key, value) VALUES (?, ?);",
      "schema_version",
      String(SCHEMA_VERSION),
    );
  });

  return database;
}

module.exports = {
  SCHEMA_VERSION,
  initializeLocalDatabase,
};
