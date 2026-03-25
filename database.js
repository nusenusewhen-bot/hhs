const Database = require('better-sqlite3');
const db = new Database('./trades.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channelId TEXT,
    user1Id TEXT,
    user2Id TEXT,
    senderId TEXT,
    receiverId TEXT,
    amount REAL DEFAULT 0,
    fee REAL DEFAULT 0,
    ltcPrice REAL DEFAULT 0,
    totalLtc REAL DEFAULT 0,
    status TEXT DEFAULT 'role_selection',
    type TEXT,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = db;
