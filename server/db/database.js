const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'face_auth.sqlite');
const db = new sqlite3.Database(dbPath);

// Promisify database operations
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initDB() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'registered',
      samples INTEGER DEFAULT 10,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at DATETIME
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS registration_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      embeddings_captured INTEGER DEFAULT 0,
      total_embeddings INTEGER DEFAULT 10,
      failure_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS authentication_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_name TEXT,
      status TEXT NOT NULL,
      similarity REAL,
      image_path TEXT,
      device_id TEXT DEFAULT 'ESP32-S3-CAM-01',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      device_name TEXT NOT NULL,
      mqtt_namespace TEXT NOT NULL,
      status TEXT DEFAULT 'ready',
      camera_status TEXT DEFAULT 'online',
      sd_card_status TEXT DEFAULT 'available',
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed default device if not present
  const device = await get(`SELECT id FROM devices WHERE id = 'ESP32-S3-CAM-01'`);
  if (!device) {
    await run(`
      INSERT INTO devices (id, device_name, mqtt_namespace, status, camera_status, sd_card_status)
      VALUES ('ESP32-S3-CAM-01', 'ESP32-S3-CAM Front Gate', '847291/583104/', 'ready', 'online', 'available')
    `);
  }

  // Seed initial user if database is completely empty
  const userCount = await get(`SELECT COUNT(*) as count FROM users`);
  if (userCount.count === 0) {
    await run(`
      INSERT INTO users (id, name, status, samples)
      VALUES (1, 'Ajeth', 'registered', 10)
    `);

    // Sample initial authorized event
    await run(`
      INSERT INTO authentication_events (user_id, user_name, status, similarity, device_id, created_at)
      VALUES (1, 'Ajeth', 'authorized', 0.894, 'ESP32-S3-CAM-01', datetime('now', '-25 minutes'))
    `);
  }
}

// Initialize tables immediately
initDB().catch(err => {
  console.error('[Database] Failed to initialize tables:', err);
});

module.exports = {
  db,
  run,
  get,
  all,
  initDB
};
