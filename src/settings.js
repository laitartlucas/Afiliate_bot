const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');

function getFile(userId) {
  return path.join(DATA_DIR, `settings-${userId}.json`);
}

function load(userId) {
  try { return JSON.parse(fs.readFileSync(getFile(userId), 'utf8')); }
  catch { return {}; }
}

function get(key, userId) {
  return load(userId)[key] ?? null;
}

function set(key, value, userId) {
  const data = load(userId);
  data[key] = value;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(getFile(userId), JSON.stringify(data, null, 2));
}

module.exports = { get, set };
