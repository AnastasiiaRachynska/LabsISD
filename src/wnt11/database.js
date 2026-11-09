"use strict";

const SCHEMA_SQL = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_hash TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens(user_id);

  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version >= 1),
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, owner_id)
  );
  CREATE INDEX IF NOT EXISTS entries_owner_order_idx ON entries(owner_id, created_at, id);

  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version >= 1),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, owner_id)
  );
  CREATE INDEX IF NOT EXISTS books_owner_order_idx ON books(owner_id, created_at, id);

  CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    book_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, owner_id),
    FOREIGN KEY (book_id, owner_id) REFERENCES books(id, owner_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS chapters_owner_order_idx ON chapters(owner_id, book_id, created_at, id);

  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version >= 1),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, owner_id)
  );
  CREATE INDEX IF NOT EXISTS tags_owner_order_idx ON tags(owner_id, created_at, id);

  CREATE TABLE IF NOT EXISTS entry_tag_associations (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    UNIQUE (owner_id, entry_id, tag_id),
    FOREIGN KEY (entry_id, owner_id) REFERENCES entries(id, owner_id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id, owner_id) REFERENCES tags(id, owner_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS entry_book_associations (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    UNIQUE (owner_id, entry_id, book_id),
    FOREIGN KEY (entry_id, owner_id) REFERENCES entries(id, owner_id) ON DELETE CASCADE,
    FOREIGN KEY (book_id, owner_id) REFERENCES books(id, owner_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS entry_chapter_associations (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    UNIQUE (owner_id, entry_id, chapter_id),
    FOREIGN KEY (entry_id, owner_id) REFERENCES entries(id, owner_id) ON DELETE CASCADE,
    FOREIGN KEY (chapter_id, owner_id) REFERENCES chapters(id, owner_id) ON DELETE CASCADE,
    FOREIGN KEY (book_id, owner_id) REFERENCES books(id, owner_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS entry_links (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    entry_a_id TEXT NOT NULL,
    entry_b_id TEXT NOT NULL,
    CHECK (entry_a_id < entry_b_id),
    UNIQUE (owner_id, entry_a_id, entry_b_id),
    FOREIGN KEY (entry_a_id, owner_id) REFERENCES entries(id, owner_id) ON DELETE CASCADE,
    FOREIGN KEY (entry_b_id, owner_id) REFERENCES entries(id, owner_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sync_client_ids (
    owner_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL,
    client_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    PRIMARY KEY (owner_id, resource_type, client_id),
    UNIQUE (owner_id, resource_type, resource_id)
  );

  CREATE TABLE IF NOT EXISTS sync_changes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
    version INTEGER NOT NULL CHECK (version >= 1),
    resource_json TEXT
  );
  CREATE INDEX IF NOT EXISTS sync_changes_owner_sequence_idx
    ON sync_changes(owner_id, sequence);

  CREATE TABLE IF NOT EXISTS sync_idempotency (
    owner_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    PRIMARY KEY (owner_id, idempotency_key)
  );
`;

function createApiDatabase(databasePath = ":memory:") {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(SCHEMA_SQL);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

module.exports = {
  createApiDatabase,
};
