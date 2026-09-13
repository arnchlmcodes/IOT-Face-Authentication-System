require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const db = require('./db/database');
const mqttClient = require('./mqtt/client');
const apiRoutes = require('./routes/api');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static assets
app.use(express.static(path.join(__dirname, '../public')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Mount API routes
app.use('/api', apiRoutes);

// WebSocket Setup for Real-Time Event Dispatch
const wss = new WebSocketServer({ server, path: '/ws' });
const connectedClients = new Set();

wss.on('connection', (ws, req) => {
  console.log(`[WebSocket] Client connected from ${req.socket.remoteAddress}`);
  connectedClients.add(ws);

  // Send initial state
  const deviceStatus = mqttClient.getStatus();
  ws.send(JSON.stringify({
    event: 'connected',
    timestamp: new Date().toISOString(),
    data: {
      message: 'Connected to IoT Face Authentication Hub',
      deviceStatus
    }
  }));

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message);
      if (parsed.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      }
    } catch (e) {
      // Ignore malformed WS client messages
    }
  });

  ws.on('close', () => {
    console.log('[WebSocket] Client disconnected');
    connectedClients.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('[WebSocket] Client error:', err.message);
    connectedClients.delete(ws);
  });
});

// Broadcast helper for MQTT events
function broadcastToDashboard(payload) {
  const messageStr = JSON.stringify(payload);
  for (const client of connectedClients) {
    if (client.readyState === 1) { // OPEN
      client.send(messageStr);
    }
  }
}

// Wire MQTT broadcaster to WebSocket
mqttClient.setWsBroadcast(broadcastToDashboard);

// Connect to MQTT Broker
mqttClient.connectMQTT();

// Fallback route for SPA dashboard
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Start Server
server.listen(PORT, () => {
  console.log(`----------------------------------------------------`);
  console.log(`ESP32 Face Authentication Server running on port ${PORT}`);
  console.log(`Dashboard:  http://localhost:${PORT}`);
  console.log(`WebSocket:  ws://localhost:${PORT}/ws`);
  console.log(`MQTT:       wss://iot.coreflux.cloud:443/mqtt`);
  console.log(`Namespace:  847291/583104/`);
  console.log(`----------------------------------------------------`);
});

module.exports = { app, server };
