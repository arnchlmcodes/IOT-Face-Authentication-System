const express = require('express');
const router = express.Router();
const db = require('../db/database');
const mqttClient = require('../mqtt/client');

// GET /api/users - List active users
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

    // Check device busy state (Section 35)
    if (mqttClient.deviceState.isBusy) {
      return res.status(409).json({
        success: false,
        error: `Device is currently busy: ${mqttClient.deviceState.busyReason}`
      });
    }

    // Auto-assign next ID if not provided
    if (!id) {
      const maxIdRow = await db.get(`SELECT MAX(id) as maxId FROM users`);
      id = (maxIdRow && maxIdRow.maxId ? maxIdRow.maxId : 0) + 1;
    } else {
      id = Number(id);
    }

    // Check if ID already exists and is active
    const existing = await db.get(`SELECT id, status, deleted_at FROM users WHERE id = ?`, [id]);
    if (existing && !existing.deleted_at && existing.status === 'registered') {
      return res.status(409).json({
        success: false,
        error: `User ID ${id} is already registered.`
      });
    }

    // Insert or update pending user
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

    // Create registration job
    const jobResult = await db.run(
      `INSERT INTO registration_jobs (user_id, status, embeddings_captured, total_embeddings)
       VALUES (?, 'requested', 0, 10)`,
      [id]
    );

    // Publish MQTT command to ESP32
    try {
      mqttClient.publishRegister(id, name);
    } catch (mqttErr) {
      console.warn('[API] Could not publish MQTT command immediately:', mqttErr.message);
      // Still return success with note so dashboard can work or simulator can pick it up
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

    // Publish MQTT delete command
    try {
      mqttClient.publishDelete(id);
    } catch (mqttErr) {
      console.warn('[API] Could not publish MQTT delete command immediately:', mqttErr.message);
    }

    // Optimistically mark as deleting or await event
    await db.run(`UPDATE users SET status = 'deleting' WHERE id = ?`, [id]);

    res.json({
      success: true,
      message: `Delete command dispatched for User ${user.name} (ID: ${id})`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/auth/history - Authentication feed logs
router.get('/auth/history', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const events = await db.all(
      `SELECT id, user_id, user_name, status, similarity, image_path, device_id, created_at 
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
      `SELECT id, similarity, image_path, device_id, created_at 
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
    const totalAuths = await db.get(`SELECT COUNT(*) as count FROM authentication_events`);
    const authorizedAuths = await db.get(`SELECT COUNT(*) as count FROM authentication_events WHERE status = 'authorized'`);
    const deniedAuths = await db.get(`SELECT COUNT(*) as count FROM authentication_events WHERE status = 'denied'`);

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

// POST /api/simulator/trigger-auth - Test endpoint
router.post('/simulator/trigger-auth', async (req, res) => {
  try {
    const { status, id, name, similarity } = req.body;
    const authStatus = status || 'authorized';

    await mqttClient.handleAuthEvent({
      status: authStatus,
      id: id !== undefined ? id : (authStatus === 'authorized' ? 1 : -1),
      name: authStatus === 'authorized' ? (name || 'Ajeth') : '',
      similarity: similarity !== undefined ? Number(similarity) : (authStatus === 'authorized' ? 0.885 : 0.421)
    });

    // If denied, also simulate binary JPEG capture
    if (authStatus === 'denied') {
      const { generateMockJpegBuffer } = require('../simulator/esp32_simulator');
      const jpegBuf = generateMockJpegBuffer(Date.now());
      setTimeout(async () => {
        await mqttClient.handleBinaryImage(jpegBuf);
      }, 150);
    }

    res.json({ success: true, message: `Simulated ${authStatus} event triggered` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
