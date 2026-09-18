/**
 * ESP32-S3-CAM Firmware Hardware Simulator
 * Simulates physical button (GPIO 1), camera capture, 10-step face registration,
 * and binary JPEG streaming over MQTT WSS.
 */

const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const MQTT_TOPICS = require('../config/mqtt');

const SIMULATOR_CLIENT_ID = `ESP32_S3_CAM_SIM_${Math.random().toString(16).substring(2, 6)}`;
console.log(`[ESP32 Simulator] Booting virtual ESP32-S3-CAM firmware...`);
console.log(`[ESP32 Simulator] Connecting to ${MQTT_TOPICS.brokerUrl}`);

const client = mqtt.connect(MQTT_TOPICS.brokerUrl, {
  clientId: SIMULATOR_CLIENT_ID,
  clean: true,
  connectTimeout: 10000,
  reconnectPeriod: 5000,
  keepalive: 60,
  rejectUnauthorized: false
});

let isBusy = false;
const registeredUsers = new Map();
registeredUsers.set(1, { id: 1, name: 'Ajeth', samples: 10 });

// Generate a minimal valid JPEG binary buffer for intruder test frames
function generateMockJpegBuffer(timestamp) {
  // Return a synthetic JPEG buffer
  // Minimal valid 1x1 JPEG bytes base structure + extended frame
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
    0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
    0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
    0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
    0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
    0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
    0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
    0x00, 0xbf, 0x00, 0xff, 0xd9
  ]);
}

client.on('connect', () => {
  console.log('[ESP32 Simulator] Connected to MQTT broker!');
  
  // Subscribe to command topics
  client.subscribe([
    MQTT_TOPICS.commandRegister,
    MQTT_TOPICS.commandDelete
  ], (err) => {
    if (err) {
      console.error('[ESP32 Simulator] Subscribe error:', err);
    } else {
      console.log(`[ESP32 Simulator] Listening on:`);
      console.log(` - ${MQTT_TOPICS.commandRegister}`);
      console.log(` - ${MQTT_TOPICS.commandDelete}`);
      console.log(`\nReady. Type 'a' + Enter for Authorized Auth, 'd' for Denied Intruder Auth, 'q' to Quit.`);
    }
  });
});

client.on('message', async (topic, payload) => {
  try {
    const data = JSON.parse(payload.toString());
    console.log(`[ESP32 Simulator] Received command on [${topic}]:`, data);

    if (topic === MQTT_TOPICS.commandRegister) {
      await handleRegisterCommand(data);
    } else if (topic === MQTT_TOPICS.commandDelete) {
      await handleDeleteCommand(data);
    }
  } catch (err) {
    console.error('[ESP32 Simulator] Command parsing error:', err);
  }
});

// Handle Register Command: Simulate 10-step embedding capture
async function handleRegisterCommand(data) {
  const { id, name } = data;

  if (isBusy) {
    console.warn('[ESP32 Simulator] Device busy, rejecting register request');
    client.publish(MQTT_TOPICS.eventRegistration, JSON.stringify({
      id,
      name,
      status: 'failed',
      reason: 'device_busy'
    }));
    return;
  }

  isBusy = true;
  console.log(`[ESP32 Simulator] Starting face capture for ${name} (ID: ${id})...`);

  for (let step = 1; step <= 10; step++) {
    await new Promise(resolve => setTimeout(resolve, 800));

    console.log(`[ESP32 Simulator] Embedding ${step}/10 captured.`);
    client.publish(MQTT_TOPICS.eventRegistration, JSON.stringify({
      id,
      name,
      status: 'capturing',
      embedding: step,
      total: 10
    }));
  }

  // Final Success
  await new Promise(resolve => setTimeout(resolve, 600));
  registeredUsers.set(id, { id, name, samples: 10 });
  isBusy = false;

  console.log(`[ESP32 Simulator] Face enrollment completed and written to MicroSD!`);
  client.publish(MQTT_TOPICS.eventRegistration, JSON.stringify({
    id,
    name,
    status: 'success',
    embeddings: 10
  }));
}

// Handle Delete Command
async function handleDeleteCommand(data) {
  const { id } = data;
  console.log(`[ESP32 Simulator] Processing deletion for ID: ${id}`);

  await new Promise(resolve => setTimeout(resolve, 500));
  registeredUsers.delete(id);

  client.publish(MQTT_TOPICS.eventDeletion, JSON.stringify({
    id,
    status: 'success'
  }));
  console.log(`[ESP32 Simulator] User ${id} removed from MicroSD card.`);
}

// Simulate Physical Button Press: Authorized Face
function triggerSimulatedAuth(authorized = true) {
  if (isBusy) {
    console.warn('[ESP32 Simulator] Device busy, button ignored');
    return;
  }

  if (authorized) {
    const similarity = +(0.84 + Math.random() * 0.12).toFixed(3);
    const user = registeredUsers.get(1) || { id: 1, name: 'Ajeth' };

    console.log(`[ESP32 Simulator] Button pressed! Authorized user match: ${user.name} (${similarity})`);
    client.publish(MQTT_TOPICS.eventAuth, JSON.stringify({
      status: 'authorized',
      id: user.id,
      name: user.name,
      similarity: similarity
    }));
  } else {
    const similarity = +(0.35 + Math.random() * 0.28).toFixed(3);
    console.log(`[ESP32 Simulator] Button pressed! Intruder face detected (${similarity} < 0.70)`);

    // 1. Publish denied auth event
    client.publish(MQTT_TOPICS.eventAuth, JSON.stringify({
      status: 'denied',
      id: -1,
      name: '',
      similarity: similarity,
      image_topic: MQTT_TOPICS.eventAuthImage,
      image_format: 'image/jpeg'
    }));

    // 2. Publish binary JPEG image
    setTimeout(() => {
      const jpegBuffer = generateMockJpegBuffer(Date.now());
      console.log(`[ESP32 Simulator] Publishing binary JPEG (${jpegBuffer.length} bytes) to ${MQTT_TOPICS.eventAuthImage}`);
      client.publish(MQTT_TOPICS.eventAuthImage, jpegBuffer, { qos: 0 });
    }, 200);
  }
}

// Interactive CLI listener
if (process.stdin.isTTY) {
  process.stdin.setRawMode(false);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (text) => {
    const input = text.trim().toLowerCase();
    if (input === 'a') {
      triggerSimulatedAuth(true);
    } else if (input === 'd') {
      triggerSimulatedAuth(false);
    } else if (input === 'q') {
      console.log('[ESP32 Simulator] Exiting.');
      process.exit(0);
    }
  });
}

module.exports = {
  triggerSimulatedAuth,
  generateMockJpegBuffer
};
