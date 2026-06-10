const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '../data');
const DB_PATH = path.join(DB_DIR, 'users.db');

fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    subscription_expires_at TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getAllUsers() {
  return db.prepare(
    'SELECT id, username, subscription_expires_at, active, created_at FROM users ORDER BY created_at DESC'
  ).all();
}

function createUser(username, password, expiresAt) {
  const hash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare('INSERT INTO users (username, password_hash, subscription_expires_at) VALUES (?, ?, ?)')
    .run(username, hash, expiresAt || null);
  return result.lastInsertRowid;
}

function setPassword(id, newPassword) {
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
}

function updateUser(id, fields) {
  const allowed = ['subscription_expires_at', 'active'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
}

function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

function verifyPassword(user, password) {
  return bcrypt.compareSync(password, user.password_hash);
}

function isSubscriptionActive(user) {
  if (!user) return false;
  if (!user.subscription_expires_at) return true;
  return new Date(user.subscription_expires_at) > new Date();
}

module.exports = {
  getUser,
  getUserByUsername,
  getAllUsers,
  createUser,
  setPassword,
  updateUser,
  deleteUser,
  verifyPassword,
  isSubscriptionActive,
};
