"""Chat history in SQLite. The database and its folder are created on first use."""
import os
import sqlite3
from contextlib import closing
from datetime import datetime

from .functions_config import settings
from .functions_log import debug_log

TITLE_MAX = 60
_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    model   TEXT NOT NULL,
    title   TEXT NOT NULL,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    created         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_model ON conversations(model, updated);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
"""
ROLES = {"user", "assistant", "system"}


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _connect():
    path = settings.CHAT_DB
    fresh = not os.path.exists(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(_SCHEMA)
    if fresh:
        debug_log(f"chat database created: {path}")
    return conn


def _title(messages):
    for m in messages:
        if m["role"] == "user" and m["content"].strip():
            text = " ".join(m["content"].split())
            return text if len(text) <= TITLE_MAX else text[:TITLE_MAX - 1] + "…"
    return "Untitled"


def clean_messages(messages):
    """Return only valid {role, content} pairs, or None if the input is malformed."""
    if not isinstance(messages, list):
        return None
    out = []
    for m in messages:
        if not isinstance(m, dict) or m.get("role") not in ROLES or not isinstance(m.get("content"), str):
            return None
        out.append({"role": m["role"], "content": m["content"]})
    return out


def save_conversation(model, messages, conv_id=None):
    """Create a conversation, or replace the messages of an existing one. Returns its id,
    or None if conv_id was given but does not exist for this model."""
    now = _now()
    with closing(_connect()) as conn, conn:
        if conv_id is None:
            cur = conn.execute(
                "INSERT INTO conversations (model, title, created, updated) VALUES (?,?,?,?)",
                (model, _title(messages), now, now))
            conv_id = cur.lastrowid
        else:
            row = conn.execute("SELECT id FROM conversations WHERE id=? AND model=?",
                               (conv_id, model)).fetchone()
            if not row:
                return None
            conn.execute("UPDATE conversations SET title=?, updated=? WHERE id=?",
                         (_title(messages), now, conv_id))
            conn.execute("DELETE FROM messages WHERE conversation_id=?", (conv_id,))
        conn.executemany(
            "INSERT INTO messages (conversation_id, role, content, created) VALUES (?,?,?,?)",
            [(conv_id, m["role"], m["content"], now) for m in messages])
    debug_log(f"chat saved: id={conv_id} model={model} messages={len(messages)}")
    return conv_id


def list_conversations(model):
    with closing(_connect()) as conn:
        rows = conn.execute(
            "SELECT c.id, c.title, c.created, c.updated, "
            "(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.role != 'system') AS count "
            "FROM conversations c WHERE c.model=? ORDER BY c.updated DESC, c.id DESC",
            (model,)).fetchall()
    return [dict(r) for r in rows]


def get_conversation(conv_id):
    with closing(_connect()) as conn:
        conv = conn.execute("SELECT * FROM conversations WHERE id=?", (conv_id,)).fetchone()
        if not conv:
            return None
        msgs = conn.execute("SELECT role, content FROM messages WHERE conversation_id=? ORDER BY id",
                            (conv_id,)).fetchall()
    return {**dict(conv), "messages": [dict(m) for m in msgs]}


def delete_conversation(conv_id):
    with closing(_connect()) as conn, conn:
        n = conn.execute("DELETE FROM conversations WHERE id=?", (conv_id,)).rowcount
    debug_log(f"chat deleted: id={conv_id} removed={n}")
    return n > 0


def clear_model(model):
    """Delete every saved conversation for one model. Returns how many were removed."""
    with closing(_connect()) as conn, conn:
        n = conn.execute("DELETE FROM conversations WHERE model=?", (model,)).rowcount
    debug_log(f"chat cleared: model={model} conversations={n}")
    return n
