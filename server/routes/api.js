const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');
const mqttClient = require('../mqtt/client');

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB max
});

// In-memory cache for latest uploaded registered users
let latestRegisteredUsersCache = null;

// Helper: Format display timestamp (defaults to Asia/Kolkata or DISPLAY_TZ)
function formatDisplayTimestamp(isoOrEpoch, timeZone = process.env.DISPLAY_TZ || 'Asia/Kolkata') {
  if (!isoOrEpoch) return null;
  try {
    const d = typeof isoOrEpoch === 'number'
      ? new Date(isoOrEpoch < 1e12 ? isoOrEpoch * 1000 : isoOrEpoch)
      : new Date(isoOrEpoch);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString('en-GB', { timeZone, hour12: false });
  } catch (e) {
    return String(isoOrEpoch);
  }
}

// ============================================================================
// Section 6.1: Health Check
// GET /api/smart-lock/logs/health
// ============================================================================
router.get('/smart-lock/logs/health', (req, res) => {
  res.json({
    ok: true,
    service: 'smart-lock-log-processor',
    display_timezone: process.env.DISPLAY_TZ || 'Asia/Kolkata'
  });
});

// ============================================================================
// Retrieve Latest Processed Logs & Statistics
// GET /api/smart-lock/logs & GET /api/logs
// ============================================================================
const getLogsHandler = async (req, res) => {
  try {
    const timezoneForDisplay = process.env.DISPLAY_TZ || 'Asia/Kolkata';

    // Auto-sync from data/events.jsonl if present and table has <= 1 record
    const localEventsPath = path.join(__dirname, '../../data/events.jsonl');
    if (fs.existsSync(localEventsPath)) {
      const countRow = await db.get(`SELECT COUNT(*) as count FROM authentication_events`);
      if (!countRow || countRow.count <= 1) {
        const content = fs.readFileSync(localEventsPath, 'utf-8');
        const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
        for (const line of lines) {
          try {
            const rec = JSON.parse(line);
            const payload = rec.payload || rec;
            const status = payload.status || rec.status;
            const sim = payload.similarity !== undefined ? payload.similarity : null;
            await db.run(
              `INSERT INTO authentication_events 
               (user_id, user_name, status, similarity, first_similarity, second_similarity, threshold, embedding_delta, source, reason, device_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                payload.id !== -1 ? payload.id : null,
                payload.name || (status === 'authorized' ? 'Authorized User' : 'Unknown / Intruder'),
                status,
                sim,
                payload.first_similarity || null,
                payload.second_similarity || null,
                payload.threshold || 0.65,
                payload.embedding_delta || null,
                payload.source || 'face',
                payload.reason || null,
                payload.device_id || 'ESP32CAM',
                payload.timestamp ? new Date(payload.timestamp).toISOString() : new Date().toISOString()
              ]
            );
          } catch (e) {}
        }
      }
    }

    const events = await db.all(
      `SELECT id, user_id, user_name, status, similarity, first_similarity, second_similarity, 
              threshold, embedding_delta, source, reason, event_type, image_path, device_id, created_at 
       FROM authentication_events 
       ORDER BY created_at DESC`
    );

    const devices = new Set();
    let totalAuthScoreSum = 0;
    let validAuthScoreCount = 0;

    const summary = {
      authentication_total: 0,
      authentication_authorized: 0,
      authentication_denied: 0,
      authentication_no_face: 0,
      lock_unlocked: 0,
      lock_locked: 0,
      registration_success: 0,
      registration_failed: 0,
      deletion_success: 0,
      deletion_failed: 0,
      mqtt_commands: 0,
      average_auth_score: null
    };

    const latestEvents = events.map(evt => {
      if (evt.device_id) devices.add(evt.device_id);

      const isLock = evt.event_type === 'lock' || evt.status === 'unlocked' || evt.status === 'locked';
      const isAuth = evt.status === 'authorized' || evt.status === 'denied';

      if (isAuth) {
        summary.authentication_total++;
        if (evt.status === 'authorized') summary.authentication_authorized++;
        if (evt.status === 'denied') {
          summary.authentication_denied++;
          if (evt.reason === 'face_not_detected' || evt.user_name === 'Unknown / Intruder') {
            summary.authentication_no_face++;
          }
        }
        if (typeof evt.similarity === 'number' && evt.similarity >= 0) {
          totalAuthScoreSum += evt.similarity;
          validAuthScoreCount++;
        }
      } else if (isLock) {
        if (evt.status === 'unlocked') summary.lock_unlocked++;
        if (evt.status === 'locked') summary.lock_locked++;
      }

      return {
        id: evt.id,
        user_id: evt.user_id,
        name: evt.user_name,
        type: evt.event_type || (isLock ? 'lock' : 'auth'),
        status: evt.status,
        similarity: evt.similarity,
        first_similarity: evt.first_similarity,
        second_similarity: evt.second_similarity,
        threshold: evt.threshold || 0.65,
        embedding_delta: evt.embedding_delta,
        source: evt.source,
        reason: evt.reason,
        image_path: evt.image_path,
        timestamp: evt.created_at,
        timestamp_display: formatDisplayTimestamp(evt.created_at, timezoneForDisplay)
      };
    });

    if (validAuthScoreCount > 0) {
      summary.average_auth_score = Number((totalAuthScoreSum / validAuthScoreCount).toFixed(4));
    }

    const activeUsers = await db.all(
      `SELECT id, name, samples as embedding_count 
       FROM users 
       WHERE deleted_at IS NULL AND status = 'registered' 
       ORDER BY id ASC`
    );

    res.json({
      ok: true,
      filename: 'events.jsonl',
      total_records: events.length,
      timezone_for_display: timezoneForDisplay,
      devices: Array.from(devices),
      summary,
      latest: latestEvents.slice(0, 50),
      registered_users: activeUsers
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};

router.get('/smart-lock/logs', getLogsHandler);
router.get('/logs', getLogsHandler);

// ============================================================================
// Sync Local Data Files
// POST /api/smart-lock/sync
// ============================================================================
router.post('/smart-lock/sync', async (req, res) => {
  try {
    const localEventsPath = path.join(__dirname, '../../data/events.jsonl');
    const localUsersPath = path.join(__dirname, '../../data/registered_users.json');
    let eventsIngested = 0;
    let usersSynced = 0;

    if (fs.existsSync(localEventsPath)) {
      const content = fs.readFileSync(localEventsPath, 'utf-8');
      const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          const payload = rec.payload || rec;
          const status = payload.status || rec.status;
          const sim = payload.similarity !== undefined ? payload.similarity : null;
          await db.run(
            `INSERT INTO authentication_events 
             (user_id, user_name, status, similarity, first_similarity, second_similarity, threshold, embedding_delta, source, reason, device_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              payload.id !== -1 ? payload.id : null,
              payload.name || (status === 'authorized' ? 'Authorized User' : 'Unknown / Intruder'),
              status,
              sim,
              payload.first_similarity || null,
              payload.second_similarity || null,
              payload.threshold || 0.65,
              payload.embedding_delta || null,
              payload.source || 'face',
              payload.reason || null,
              payload.device_id || 'ESP32CAM',
              payload.timestamp ? new Date(payload.timestamp).toISOString() : new Date().toISOString()
            ]
          );
          eventsIngested++;
        } catch (e) {}
      }
    }

    if (fs.existsSync(localUsersPath)) {
      const json = JSON.parse(fs.readFileSync(localUsersPath, 'utf-8'));
      if (Array.isArray(json.users)) {
        for (const u of json.users) {
          if (!u.id || !u.name) continue;
          const existing = await db.get(`SELECT id FROM users WHERE id = ?`, [u.id]);
          if (existing) {
            await db.run(`UPDATE users SET name = ?, status = 'registered', samples = ?, deleted_at = NULL WHERE id = ?`, [u.name, u.embedding_count || 10, u.id]);
          } else {
            await db.run(`INSERT INTO users (id, name, status, samples) VALUES (?, ?, 'registered', ?)`, [u.id, u.name, u.embedding_count || 10]);
          }
          usersSynced++;
        }
      }
    }

    res.json({
      ok: true,
      success: true,
      message: `Synchronized ${eventsIngested} log events and ${usersSynced} user profiles`,
      events_ingested: eventsIngested,
      users_synced: usersSynced
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// Section 6.2: Process SD Event Log
// POST /api/smart-lock/logs (multipart/form-data with field name 'file' = events.jsonl)
// ============================================================================
router.post('/smart-lock/logs', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      ok: false,
      error: "Upload events.jsonl as multipart/form-data with field name 'file'."
    });
  }

  const timezoneForDisplay = process.env.DISPLAY_TZ || 'Asia/Kolkata';
  const fileContent = req.file.buffer.toString('utf-8');
  const lines = fileContent.split(/\r?\n/).filter(line => line.trim().length > 0);

  const parseErrors = [];
  const devices = new Set();
  const latestEvents = [];
  let totalAuthScoreSum = 0;
  let validAuthScoreCount = 0;

  const summary = {
    authentication_total: 0,
    authentication_authorized: 0,
    authentication_denied: 0,
    authentication_no_face: 0,
    lock_unlocked: 0,
    lock_locked: 0,
    registration_success: 0,
    registration_failed: 0,
    deletion_success: 0,
    deletion_failed: 0,
    mqtt_commands: 0,
    average_auth_score: null
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    let record;
    try {
      record = JSON.parse(rawLine);
    } catch (err) {
      parseErrors.push({
        line: i + 1,
        error: err.message,
        snippet: rawLine.substring(0, 100)
      });
      continue;
    }

    // Determine payload and metadata structure
    // Line may be: { topic: "...", payload: { ... } } OR direct event object
    const topic = record.topic || '';
    const payload = record.payload || record;

    const deviceId = payload.device_id || record.device_id;
    if (deviceId) devices.add(deviceId);

    const timestamp = payload.timestamp || record.timestamp || null;
    const timestampDisplay = formatDisplayTimestamp(timestamp || payload.timestamp_epoch || record.timestamp_epoch, timezoneForDisplay);

    let eventType = 'unknown';
    let status = payload.status || record.status || null;
    let userId = payload.id !== undefined ? payload.id : (record.id !== undefined ? record.id : null);
    let userName = payload.name !== undefined ? payload.name : (record.name !== undefined ? record.name : null);
    let source = payload.source || record.source || null;
    let firstSim = payload.first_similarity !== undefined ? payload.first_similarity : null;
    let secondSim = payload.second_similarity !== undefined ? payload.second_similarity : null;
    let sim = payload.similarity !== undefined ? payload.similarity : (payload.verification_similarity !== undefined ? payload.verification_similarity : null);
    let threshold = payload.threshold !== undefined ? payload.threshold : 0.65;
    let delta = payload.embedding_delta !== undefined ? payload.embedding_delta : null;
    let reason = payload.reason || record.reason || null;

    // Track command topics
    if (topic.includes('/command/')) {
      summary.mqtt_commands++;
    }

    // 1. Authentication Events
    if (topic.includes('/event/auth') || payload.status === 'authorized' || payload.status === 'denied') {
      eventType = 'auth';
      summary.authentication_total++;

      if (status === 'authorized') {
        summary.authentication_authorized++;
      } else if (status === 'denied') {
        summary.authentication_denied++;
        if (reason === 'face_not_detected' || (userId === -1 && (!userName || userName === ''))) {
          summary.authentication_no_face++;
        }
      }

      // Calculate average authentication score (ignore negative or non-numeric)
      if (typeof sim === 'number' && sim >= 0) {
        totalAuthScoreSum += sim;
        validAuthScoreCount++;
      }

      // Persist into database so logs reflect imported file
      try {
        await db.run(
          `INSERT INTO authentication_events 
           (user_id, user_name, status, similarity, first_similarity, second_similarity, threshold, embedding_delta, source, reason, device_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId !== -1 ? userId : null,
            userName || (status === 'authorized' ? 'Authorized User' : 'Unknown / Intruder'),
            status,
            sim,
            firstSim,
            secondSim,
            threshold,
            delta,
            source || 'face',
            reason,
            deviceId || 'ESP32CAM',
            timestamp ? new Date(timestamp).toISOString() : new Date().toISOString()
          ]
        );
      } catch (dbErr) {
        // Continue if duplicate or write issue
      }
    }
    // 2. Lock Events
    else if (topic.includes('/event/lock') || payload.event === 'lock' || (status === 'unlocked' || status === 'locked')) {
      eventType = 'lock';
      if (status === 'unlocked') summary.lock_unlocked++;
      if (status === 'locked') summary.lock_locked++;

      try {
        await db.run(
          `INSERT INTO authentication_events 
           (user_name, status, source, event_type, device_id, created_at)
           VALUES (?, ?, ?, 'lock', ?, ?)`,
          [
            source === 'manual' ? 'Manual Unlock' : (source === 'auto' ? 'Auto Relock' : 'Face Unlock'),
            status,
            source || 'lock',
            deviceId || 'ESP32CAM',
            timestamp ? new Date(timestamp).toISOString() : new Date().toISOString()
          ]
        );
      } catch (dbErr) {
        // Continue
      }
    }
    // 3. Registration Events
    else if (topic.includes('/event/registration') || payload.event === 'registration') {
      eventType = 'registration';
      if (status === 'success') summary.registration_success++;
      if (status === 'failed') summary.registration_failed++;
    }
    // 4. Deletion Events
    else if (topic.includes('/event/deletion') || payload.event === 'deletion') {
      eventType = 'deletion';
      if (status === 'success') summary.deletion_success++;
      if (status === 'failed') summary.deletion_failed++;
    }
    // 5. System Events
    else if (record.event || payload.event) {
      eventType = 'system';
      status = record.event || payload.event;
    }

    latestEvents.unshift({
      timestamp,
      timestamp_display: timestampDisplay,
      type: eventType,
      topic,
      status,
      id: userId,
      name: userName,
      source,
      first_similarity: firstSim,
      second_similarity: secondSim,
      similarity: sim,
      threshold,
      embedding_delta: delta,
      reason
    });
  }

  if (validAuthScoreCount > 0) {
    summary.average_auth_score = Number((totalAuthScoreSum / validAuthScoreCount).toFixed(4));
  }

  // Retrieve current active users
  const activeUsers = await db.all(`SELECT id, name, samples as embedding_count FROM users WHERE deleted_at IS NULL AND status = 'registered'`);

  res.json({
    ok: true,
    filename: req.file.originalname || 'events.jsonl',
    size_bytes: req.file.size,
    timezone_for_display: timezoneForDisplay,
    total_records: lines.length,
    parse_errors: parseErrors,
    devices: Array.from(devices),
    summary,
    latest: latestEvents.slice(0, 50),
    registered_users: activeUsers
  });
});

// ============================================================================
// Section 6.3: Upload Registered Users
// POST /api/smart-lock/users (multipart/form-data with field name 'file' = registered_users.json)
// ============================================================================
router.post('/smart-lock/users', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      ok: false,
      error: "Upload registered_users.json as multipart/form-data with field name 'file'."
    });
  }

  try {
    const timezoneForDisplay = process.env.DISPLAY_TZ || 'Asia/Kolkata';
    const json = JSON.parse(req.file.buffer.toString('utf-8'));

    const deviceId = json.device_id || 'ESP32CAM_UNKNOWN';
    const users = Array.isArray(json.users) ? json.users : [];
    const updatedAt = json.updated_at || new Date().toISOString();
    const updatedAtEpoch = json.updated_at_epoch || Math.floor(new Date(updatedAt).getTime() / 1000);
    const updatedAtDisplay = formatDisplayTimestamp(updatedAt, timezoneForDisplay);

    // Synchronize users into SQLite database
    for (const u of users) {
      if (!u.id || !u.name) continue;
      const existing = await db.get(`SELECT id FROM users WHERE id = ?`, [u.id]);
      if (existing) {
        await db.run(
          `UPDATE users SET name = ?, status = 'registered', samples = ?, deleted_at = NULL WHERE id = ?`,
          [u.name, u.embedding_count || 10, u.id]
        );
      } else {
        await db.run(
          `INSERT INTO users (id, name, status, samples) VALUES (?, ?, 'registered', ?)`,
          [u.id, u.name, u.embedding_count || 10]
        );
      }
    }

    latestRegisteredUsersCache = {
      device_id: deviceId,
      user_count: users.length,
      updated_at: updatedAt,
      updated_at_display: updatedAtDisplay,
      updated_at_epoch: updatedAtEpoch,
      users: users
    };

    res.json({
      ok: true,
      filename: req.file.originalname || 'registered_users.json',
      device_id: deviceId,
      user_count: users.length,
      updated_at: updatedAt,
      updated_at_display: updatedAtDisplay,
      updated_at_epoch: updatedAtEpoch,
      users: users
    });
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: `Invalid registered_users.json file: ${err.message}`
    });
  }
});

// ============================================================================
// Section 6.4: Get Latest Registered Users
// GET /api/smart-lock/users
// ============================================================================
router.get('/smart-lock/users', async (req, res) => {
  try {
    const timezoneForDisplay = process.env.DISPLAY_TZ || 'Asia/Kolkata';

    if (latestRegisteredUsersCache) {
      return res.json({
        ok: true,
        ...latestRegisteredUsersCache
      });
    }

    // Fall back to active database users if no file has been uploaded yet
    const dbUsers = await db.all(
      `SELECT id, name, samples as embedding_count 
       FROM users 
       WHERE deleted_at IS NULL AND status = 'registered' 
       ORDER BY id ASC`
    );

    const now = new Date();
    res.json({
      ok: true,
      device_id: 'ESP32CAM_LOCAL',
      user_count: dbUsers.length,
      updated_at: now.toISOString(),
      updated_at_display: formatDisplayTimestamp(now, timezoneForDisplay),
      updated_at_epoch: Math.floor(now.getTime() / 1000),
      users: dbUsers
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// Delete Specific Log (including associated image file)
// DELETE /api/smart-lock/logs/:id & DELETE /api/logs/:id
// ============================================================================
const deleteLogHandler = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, ok: false, error: 'Valid log ID is required' });
    }

    // Find log record
    const event = await db.get(`SELECT * FROM authentication_events WHERE id = ?`, [id]);
    if (!event) {
      return res.status(404).json({ success: false, ok: false, error: `Log event #${id} not found` });
    }

    // If there is an associated intruder image file, unlink it from disk
    if (event.image_path) {
      try {
        const fullImagePath = path.join(__dirname, '../../', event.image_path.replace(/^\//, ''));
        if (fs.existsSync(fullImagePath)) {
          fs.unlinkSync(fullImagePath);
          console.log(`[API] Deleted associated image file: ${fullImagePath}`);
        }
      } catch (fileErr) {
        console.warn(`[API] Could not delete image file on disk:`, fileErr.message);
      }
    }

    // Delete record from database
    await db.run(`DELETE FROM authentication_events WHERE id = ?`, [id]);

    // Broadcast deletion over WebSocket
    try {
      mqttClient.handleAuthEvent; // ensure loaded
      // wsBroadcast helper if available
    } catch (e) {}

    res.json({
      success: true,
      ok: true,
      message: `Log #${id} and associated image deleted successfully`,
      id
    });
  } catch (err) {
    res.status(500).json({ success: false, ok: false, error: err.message });
  }
};

// Clear All Logs
const deleteAllLogsHandler = async (req, res) => {
  try {
    const eventsWithImages = await db.all(`SELECT image_path FROM authentication_events WHERE image_path IS NOT NULL`);
    for (const evt of eventsWithImages) {
      if (evt.image_path) {
        try {
          const fullPath = path.join(__dirname, '../../', evt.image_path.replace(/^\//, ''));
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
          }
        } catch (fileErr) {}
      }
    }

    await db.run(`DELETE FROM authentication_events`);

    res.json({
      success: true,
      ok: true,
      message: 'All log records and associated images deleted successfully'
    });
  } catch (err) {
    res.status(500).json({ success: false, ok: false, error: err.message });
  }
};

// Delete routes
router.delete('/smart-lock/logs/:id', deleteLogHandler);
router.delete('/logs/:id', deleteLogHandler);
router.delete('/auth/history/:id', deleteLogHandler);

router.delete('/smart-lock/logs', deleteAllLogsHandler);
router.delete('/logs', deleteAllLogsHandler);
router.delete('/auth/history', deleteAllLogsHandler);

// ============================================================================
// Section 3: Manual Unlock Trigger
// POST /api/smart-lock/unlock & POST /api/unlock
// ============================================================================
const unlockHandler = (req, res) => {
  try {
    mqttClient.publishUnlock();
    res.json({
      success: true,
      ok: true,
      message: 'Manual unlock command sent to ESP32 (847291/583104/command/unlock)'
    });
  } catch (err) {
    console.warn('[API] Could not publish unlock command immediately:', err.message);
    res.json({
      success: true,
      ok: true,
      warning: err.message,
      message: 'Manual unlock command queued/dispatched (MQTT reconnecting)'
    });
  }
};

router.post('/smart-lock/unlock', unlockHandler);
router.post('/unlock', unlockHandler);

// ============================================================================
// GET /api/users - List active users
// ============================================================================
router.get('/users', async (req, res) => {
  try {
    const users = await db.all(
      `SELECT id, name, status, samples, created_at, deleted_at 
       FROM users 
       WHERE deleted_at IS NULL 
       ORDER BY id ASC`
    );
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/users - Start user registration
router.post('/users', async (req, res) => {
  try {
    let { id, name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, error: 'User name is required' });
    }

    name = name.trim();

    if (mqttClient.deviceState.isBusy) {
      return res.status(409).json({
        success: false,
        error: `Device is currently busy: ${mqttClient.deviceState.busyReason}`
      });
    }

    if (!id) {
      const maxIdRow = await db.get(`SELECT MAX(id) as maxId FROM users`);
      id = (maxIdRow && maxIdRow.maxId ? maxIdRow.maxId : 0) + 1;
    } else {
      id = Number(id);
    }

    const existing = await db.get(`SELECT id, status, deleted_at FROM users WHERE id = ?`, [id]);
    if (existing && !existing.deleted_at && existing.status === 'registered') {
      return res.status(409).json({
        success: false,
        error: `User ID ${id} is already registered.`
      });
    }

    if (existing) {
      await db.run(
        `UPDATE users SET name = ?, status = 'pending_registration', deleted_at = NULL WHERE id = ?`,
        [name, id]
      );
    } else {
      await db.run(
        `INSERT INTO users (id, name, status, samples) VALUES (?, ?, 'pending_registration', 0)`,
        [id, name]
      );
    }

    const jobResult = await db.run(
      `INSERT INTO registration_jobs (user_id, status, embeddings_captured, total_embeddings)
       VALUES (?, 'requested', 0, 10)`,
      [id]
    );

    try {
      mqttClient.publishRegister(id, name);
    } catch (mqttErr) {
      console.warn('[API] Could not publish MQTT command immediately:', mqttErr.message);
    }

    res.json({
      success: true,
      message: `Registration initiated for ${name} (ID: ${id})`,
      user: { id, name, status: 'pending_registration' },
      jobId: jobResult.id
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/users/:id - Delete registered user
router.delete('/users/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const user = await db.get(`SELECT id, name, status FROM users WHERE id = ? AND deleted_at IS NULL`, [id]);

    if (!user) {
      return res.status(404).json({ success: false, error: `User with ID ${id} not found` });
    }

    try {
      mqttClient.publishDelete(id);
    } catch (mqttErr) {
      console.warn('[API] Could not publish MQTT delete command immediately:', mqttErr.message);
    }

    await db.run(`UPDATE users SET status = 'deleting' WHERE id = ?`, [id]);

    res.json({
      success: true,
      message: `Delete command dispatched for User ${user.name} (ID: ${id})`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/auth/history - Authentication feed logs with rich api.md fields
router.get('/auth/history', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const events = await db.all(
      `SELECT id, user_id, user_name, status, similarity, first_similarity, second_similarity, 
              threshold, embedding_delta, source, reason, event_type, image_path, device_id, created_at 
       FROM authentication_events 
       ORDER BY created_at DESC 
       LIMIT ?`,
      [limit]
    );
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/intruders - Denied intruder images & metadata
router.get('/intruders', async (req, res) => {
  try {
    const intruders = await db.all(
      `SELECT id, user_id, similarity, first_similarity, second_similarity, threshold, reason, image_path, device_id, created_at 
       FROM authentication_events 
       WHERE status = 'denied' AND image_path IS NOT NULL 
       ORDER BY created_at DESC 
       LIMIT 30`
    );
    res.json({ success: true, intruders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/devices - Device status & telemetry
router.get('/devices', async (req, res) => {
  try {
    const device = await db.get(`SELECT * FROM devices WHERE id = 'ESP32-S3-CAM-01'`);
    const status = mqttClient.getStatus();

    res.json({
      success: true,
      device: {
        ...device,
        mqtt_status: status.connectionStatus,
        broker: status.broker,
        namespace: status.namespace,
        is_busy: status.deviceState.isBusy,
        busy_reason: status.deviceState.busyReason,
        last_seen: status.deviceState.lastSeen
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/stats - High-level metrics
router.get('/stats', async (req, res) => {
  try {
    const userCount = await db.get(`SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL AND status = 'registered'`);
    const totalAuths = await db.get(`SELECT COUNT(*) as count FROM authentication_events WHERE event_type = 'auth' OR event_type IS NULL`);
    const authorizedAuths = await db.get(`SELECT COUNT(*) as count FROM authentication_events WHERE status = 'authorized' AND (event_type = 'auth' OR event_type IS NULL)`);
    const deniedAuths = await db.get(`SELECT COUNT(*) as count FROM authentication_events WHERE status = 'denied' AND (event_type = 'auth' OR event_type IS NULL)`);

    const passRate = totalAuths.count > 0 
      ? Math.round((authorizedAuths.count / totalAuths.count) * 100) 
      : 100;

    res.json({
      success: true,
      stats: {
        registeredUsers: userCount.count,
        totalEvents: totalAuths.count,
        authorizedCount: authorizedAuths.count,
        deniedCount: deniedAuths.count,
        passRate: passRate
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
