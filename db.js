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
        // Query to get the latest message for each chat
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
        return stmt.all().map(row => ({
            ...row,
            fromMe: row.from_me === 1,
            raw_data: JSON.parse(row.raw_data)
        }));
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
    }
};
