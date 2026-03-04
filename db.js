const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}

const db = new Database(path.join(dataDir, 'chat.db'));

// Initialize database schema
db.pragma('journal_mode = WAL');

// Messages table
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    body TEXT,
    from_me INTEGER NOT NULL DEFAULT 0,
    sender_name TEXT,
    time INTEGER NOT NULL,
    type TEXT NOT NULL,
    caption TEXT,
    quoted_msg_id TEXT,
    raw_data JSON
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
  CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(time);
`);

// Contact tags table
db.exec(`
  CREATE TABLE IF NOT EXISTS contact_tags (
    chat_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (chat_id, tag)
  );
  CREATE INDEX IF NOT EXISTS idx_contact_tags_tag ON contact_tags(tag);
`);

module.exports = {
    // Save a new message
    saveMessage: (msg) => {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO messages (
                id, chat_id, body, from_me, sender_name, time, type, caption, quoted_msg_id, raw_data
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
            msg.id,
            msg.chatId,
            msg.body || '',
            msg.fromMe ? 1 : 0,
            msg.senderName || '',
            msg.time || Math.floor(Date.now() / 1000),
            msg.type || 'chat',
            msg.caption || '',
            msg.quotedMsgId || '',
            JSON.stringify(msg)
        );
        return msg;
    },

    // Get list of all chats (unique chat_ids with their latest message)
    getChats: () => {
        const stmt = db.prepare(`
            SELECT m1.* 
            FROM messages m1
            INNER JOIN (
                SELECT chat_id, MAX(time) as max_time
                FROM messages
                GROUP BY chat_id
            ) m2 ON m1.chat_id = m2.chat_id AND m1.time = m2.max_time
            ORDER BY m1.time DESC
        `);
        const chats = stmt.all().map(row => ({
            ...row,
            fromMe: row.from_me === 1,
            raw_data: JSON.parse(row.raw_data)
        }));

        // Attach tags to each chat
        const tagStmt = db.prepare('SELECT tag FROM contact_tags WHERE chat_id = ?');
        chats.forEach(chat => {
            chat.tags = tagStmt.all(chat.chat_id).map(r => r.tag);
        });

        return chats;
    },

    // Get messages for a specific chat
    getChatMessages: (chatId, limit = 100) => {
        const stmt = db.prepare(`
            SELECT * FROM messages 
            WHERE chat_id = ? 
            ORDER BY time ASC 
            LIMIT ?
        `);
        return stmt.all(chatId, limit).map(row => ({
            ...row,
            fromMe: row.from_me === 1,
            raw_data: JSON.parse(row.raw_data)
        }));
    },

    // Check if a message exists
    messageExists: (id) => {
        const stmt = db.prepare('SELECT 1 FROM messages WHERE id = ?');
        const row = stmt.get(id);
        return !!row;
    },

    // Tag management
    getTagsForChat: (chatId) => {
        const stmt = db.prepare('SELECT tag FROM contact_tags WHERE chat_id = ?');
        return stmt.all(chatId).map(r => r.tag);
    },

    addTag: (chatId, tag) => {
        const stmt = db.prepare('INSERT OR IGNORE INTO contact_tags (chat_id, tag) VALUES (?, ?)');
        stmt.run(chatId, tag);
    },

    removeTag: (chatId, tag) => {
        const stmt = db.prepare('DELETE FROM contact_tags WHERE chat_id = ? AND tag = ?');
        stmt.run(chatId, tag);
    },

    getChatsByTag: (tag) => {
        const stmt = db.prepare('SELECT chat_id FROM contact_tags WHERE tag = ?');
        return stmt.all(tag).map(r => r.chat_id);
    },

    getAllTags: () => {
        const stmt = db.prepare('SELECT DISTINCT tag FROM contact_tags ORDER BY tag');
        return stmt.all().map(r => r.tag);
    }
};
