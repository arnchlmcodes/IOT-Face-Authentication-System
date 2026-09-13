const mqtt = require('mqtt');
const path = require('path');
const fs = require('fs');
const MQTT_TOPICS = require('../config/mqtt');
const db = require('../db/database');

let mqttClient = null;
let wsBroadcastFn = null;
let connectionStatus = 'disconnected';
let lastDeniedAuthEvent = null;

// Track device active state
let deviceState = {
  isBusy: false,
  busyReason: null,
  activeUserId: null,
  activeUserName: null,
  lastSeen: new Date().toISOString()
};

function setWsBroadcast(broadcastFn) {
  wsBroadcastFn = broadcastFn;
}

function broadcast(eventType, data) {
  if (wsBroadcastFn) {
    wsBroadcastFn({
      event: eventType,
      timestamp: new Date().toISOString(),
      data
    });
  }
}

function connectMQTT() {
  console.log(`[MQTT] Connecting to ${MQTT_TOPICS.brokerUrl}...`);
  connectionStatus = 'connecting';

  mqttClient = mqtt.connect(MQTT_TOPICS.brokerUrl, {
    clientId: `iot_backend_${Math.random().toString(16).substring(2, 8)}`,
    clean: true,
    connectTimeout: 10000,
    reconnectPeriod: 5000,
    keepalive: 60,
    rejectUnauthorized: false
  });

  mqttClient.on('connect', () => {
    console.log('[MQTT] Connected to broker successfully');
    connectionStatus = 'connected';
    deviceState.lastSeen = new Date().toISOString();

    // Subscribe to all events in namespace
    mqttClient.subscribe(MQTT_TOPICS.eventSubscription, { qos: 0 }, (err) => {
      if (err) {
        console.error('[MQTT] Subscription failed:', err);
      } else {
        console.log(`[MQTT] Subscribed to ${MQTT_TOPICS.eventSubscription}`);
      }
    });

    broadcast('device_status', {
      mqtt: 'connected',
      broker: MQTT_TOPICS.brokerUrl,
      namespace: MQTT_TOPICS.namespace,
      deviceState
    });
  });

  mqttClient.on('reconnect', () => {
    console.log('[MQTT] Reconnecting to broker...');
    connectionStatus = 'reconnecting';
    broadcast('device_status', { mqtt: 'reconnecting', deviceState });
  });

  mqttClient.on('close', () => {
    console.log('[MQTT] Connection closed');
    connectionStatus = 'disconnected';
    broadcast('device_status', { mqtt: 'disconnected', deviceState });
  });

  mqttClient.on('error', (err) => {
    console.error('[MQTT] Error:', err.message);
    connectionStatus = 'error';
    broadcast('device_status', { mqtt: 'error', error: err.message, deviceState });
  });

  // Handle incoming MQTT messages
  mqttClient.on('message', async (topic, payload) => {
    deviceState.lastSeen = new Date().toISOString();

    // 1. Binary JPEG handling for intruder / denied authentication
    if (topic === MQTT_TOPICS.eventAuthImage) {
      console.log(`[MQTT] Received raw binary JPEG (${payload.length} bytes) on ${topic}`);
      await handleBinaryImage(payload);
      return;
    }

    // 2. JSON Event Handling
    let json;
    try {
      json = JSON.parse(payload.toString());
    } catch (e) {
      console.warn(`[MQTT] Non-JSON message on ${topic}:`, payload.toString().slice(0, 100));
      return;
    }

    console.log(`[MQTT] Event received on [${topic}]:`, json);

    switch (topic) {
      case MQTT_TOPICS.eventRegistration:
        await handleRegistrationEvent(json);
        break;

      case MQTT_TOPICS.eventDeletion:
        await handleDeletionEvent(json);
        break;

      case MQTT_TOPICS.eventAuth:
        await handleAuthEvent(json);
        break;

      default:
        console.log(`[MQTT] Unhandled topic: ${topic}`);
    }
  });
}

// Handler for registration progress, success, or failure
async function handleRegistrationEvent(data) {
  const { id, name, status, embedding, total = 10, embeddings, reason } = data;

  if (status === 'capturing') {
    deviceState.isBusy = true;
    deviceState.busyReason = `Capturing embedding ${embedding}/${total} for ${name}`;
    deviceState.activeUserId = id;
    deviceState.activeUserName = name;

    await db.run(
      `UPDATE registration_jobs 
       SET status = 'capturing', embeddings_captured = ? 
       WHERE user_id = ? AND status IN ('requested', 'capturing')`,
      [embedding, id]
    );

    broadcast('registration_progress', {
      id,
      name,
      status: 'capturing',
      embedding,
      total,
      percentage: Math.round((embedding / total) * 100)
    });
  } else if (status === 'success') {
    deviceState.isBusy = false;
    deviceState.busyReason = null;
    deviceState.activeUserId = null;
    deviceState.activeUserName = null;

    // Update user record in DB
    await db.run(
      `UPDATE users SET status = 'registered', samples = ?, deleted_at = NULL WHERE id = ?`,
      [embeddings || total || 10, id]
    );

    // Update registration job
    await db.run(
      `UPDATE registration_jobs 
       SET status = 'success', embeddings_captured = ?, completed_at = CURRENT_TIMESTAMP 
       WHERE user_id = ? AND status IN ('requested', 'capturing')`,
      [embeddings || total || 10, id]
    );

    broadcast('registration_success', {
      id,
      name,
      status: 'success',
      embeddings: embeddings || total || 10
    });
  } else if (status === 'failed') {
    deviceState.isBusy = false;
    deviceState.busyReason = null;
    deviceState.activeUserId = null;
    deviceState.activeUserName = null;

    await db.run(
      `UPDATE registration_jobs 
       SET status = 'failed', failure_reason = ?, completed_at = CURRENT_TIMESTAMP 
       WHERE user_id = ? AND status IN ('requested', 'capturing')`,
      [reason || 'unknown', id]
    );

    await db.run(
      `UPDATE users SET status = 'failed' WHERE id = ? AND status = 'pending_registration'`,
      [id]
    );

    broadcast('registration_failed', {
      id,
      name,
      status: 'failed',
      reason: reason || 'Unknown error'
    });
  }
}

// Handler for user deletion confirmation
async function handleDeletionEvent(data) {
  const { id, status, reason } = data;

  if (status === 'success') {
    await db.run(
      `UPDATE users SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id]
    );

    broadcast('deletion_success', {
      id,
      status: 'success'
    });
  } else {
    broadcast('deletion_failed', {
      id,
      status: 'failed',
      reason: reason || 'Deletion rejected by ESP32'
    });
  }
}

// Handler for authentication events (authorized / denied)
async function handleAuthEvent(data) {
  const { status, id, name, similarity, reason } = data;

  if (status === 'authorized') {
    const result = await db.run(
      `INSERT INTO authentication_events (user_id, user_name, status, similarity, device_id)
       VALUES (?, ?, 'authorized', ?, 'ESP32-S3-CAM-01')`,
      [id, name, similarity]
    );

    broadcast('authentication_authorized', {
      id,
      name,
      status: 'authorized',
      similarity,
      eventId: result.id,
      timestamp: new Date().toISOString()
    });
  } else if (status === 'denied') {
    // Record denied event
    const result = await db.run(
      `INSERT INTO authentication_events (user_id, user_name, status, similarity, device_id)
       VALUES (NULL, 'Unknown / Intruder', 'denied', ?, 'ESP32-S3-CAM-01')`,
      [similarity !== undefined ? similarity : 0.0]
    );

    lastDeniedAuthEvent = {
      id: result.id,
      similarity,
      reason: reason || 'Face not recognized',
      timestamp: new Date().toISOString()
    };

    broadcast('authentication_denied', {
      status: 'denied',
      similarity,
      reason: reason || 'Face does not meet authorization threshold',
      eventId: result.id,
      timestamp: new Date().toISOString()
    });
  }
}

// Handler for raw binary JPEG
async function handleBinaryImage(jpegBuffer) {
  try {
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    const uploadsDir = path.join(__dirname, '../../uploads/intruders', year, month, day);
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const timestamp = now.getTime();
    const filename = `auth_${timestamp}_${Math.random().toString(36).substring(2, 7)}.jpg`;
    const fullPath = path.join(uploadsDir, filename);
    const relativeWebPath = `/uploads/intruders/${year}/${month}/${day}/${filename}`;

    fs.writeFileSync(fullPath, jpegBuffer);
    console.log(`[MQTT] Intruder image saved to: ${fullPath} (${jpegBuffer.length} bytes)`);

    // Correlate with latest denied auth event
    if (lastDeniedAuthEvent) {
      await db.run(
        `UPDATE authentication_events SET image_path = ? WHERE id = ?`,
        [relativeWebPath, lastDeniedAuthEvent.id]
      );
      lastDeniedAuthEvent.imagePath = relativeWebPath;
    }

    broadcast('intruder_image', {
      imagePath: relativeWebPath,
      sizeBytes: jpegBuffer.length,
      timestamp: now.toISOString(),
      eventId: lastDeniedAuthEvent ? lastDeniedAuthEvent.id : null,
      similarity: lastDeniedAuthEvent ? lastDeniedAuthEvent.similarity : null
    });
  } catch (err) {
    console.error('[MQTT] Failed to save binary intruder image:', err);
  }
}

// Publishing commands to ESP32
function publishRegister(id, name) {
  if (!mqttClient || !mqttClient.connected) {
    throw new Error('MQTT broker is disconnected');
  }

  const payload = JSON.stringify({ id: Number(id), name: String(name).trim() });
  console.log(`[MQTT] Publishing register command to [${MQTT_TOPICS.commandRegister}]:`, payload);

  deviceState.isBusy = true;
  deviceState.busyReason = `Starting registration for ${name}`;
  deviceState.activeUserId = id;
  deviceState.activeUserName = name;

  mqttClient.publish(MQTT_TOPICS.commandRegister, payload, { qos: 0 });
}

function publishDelete(id) {
  if (!mqttClient || !mqttClient.connected) {
    throw new Error('MQTT broker is disconnected');
  }

  const payload = JSON.stringify({ id: Number(id) });
  console.log(`[MQTT] Publishing delete command to [${MQTT_TOPICS.commandDelete}]:`, payload);

  mqttClient.publish(MQTT_TOPICS.commandDelete, payload, { qos: 0 });
}

function getStatus() {
  return {
    connectionStatus,
    broker: MQTT_TOPICS.brokerUrl,
    namespace: MQTT_TOPICS.namespace,
    deviceState
  };
}

module.exports = {
  connectMQTT,
  setWsBroadcast,
  publishRegister,
  publishDelete,
  getStatus,
  deviceState,
  handleAuthEvent,
  handleRegistrationEvent,
  handleDeletionEvent,
  handleBinaryImage
};
