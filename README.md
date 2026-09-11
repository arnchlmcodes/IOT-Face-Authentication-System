# ESP32-S3 Face Authentication System

A full-stack IoT security platform that connects an ESP32-S3-CAM to a Node.js backend and a real-time web dashboard. The system handles biometric face enrollment, identity verification, and intruder detection over MQTT.

---

## Architecture

```
Dashboard (Browser)
    |
    | HTTP REST / WebSocket
    v
Node.js Backend Server
    |
    | MQTT over WSS (Port 443)
    v
MQTT Broker (iot.coreflux.cloud)
    |
    | MQTT
    v
ESP32-S3-CAM (Physical Device)
```

---

## Features

- MQTT client over WSS connected to a public broker on namespace `847291/583104/`
- REST API for user registration, deletion, authentication logs, and device status
- WebSocket hub for real-time event streaming to the dashboard
- SQLite database for persistent storage of users, registration jobs, and auth events
- Binary JPEG pipeline for capturing and storing denied authentication images
- 10-step face enrollment flow with live progress tracking
- Built-in ESP32 hardware simulator for testing without physical hardware
- Intruder gallery with captured snapshots from denied access attempts

---

## MQTT Topics

| Direction | Topic | Payload |
|-----------|-------|---------|
| Backend to ESP32 | `847291/583104/command/register` | JSON |
| Backend to ESP32 | `847291/583104/command/delete` | JSON |
| ESP32 to Backend | `847291/583104/event/registration` | JSON |
| ESP32 to Backend | `847291/583104/event/deletion` | JSON |
| ESP32 to Backend | `847291/583104/event/auth` | JSON |
| ESP32 to Backend | `847291/583104/event/auth/image` | Binary JPEG |

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | List registered users |
| POST | `/api/users` | Register a new user and begin face enrollment |
| DELETE | `/api/users/:id` | Delete a user from the ESP32 database |
| GET | `/api/auth/history` | Fetch authentication event logs |
| GET | `/api/intruders` | List denied authentication events with images |
| GET | `/api/devices` | Device status and telemetry |
| GET | `/api/stats` | Summary statistics |
| POST | `/api/simulator/trigger-auth` | Trigger a simulated authentication event |

---

## Getting Started

### Install dependencies

```bash
npm install
```

### Start the server and dashboard

```bash
npm start
```

The server runs on `http://localhost:3000`.

### Run the hardware simulator (optional)

```bash
npm run sim
```

---

## Tech Stack

- **Runtime**: Node.js
- **Backend**: Express, ws, mqtt
- **Database**: SQLite3
- **Frontend**: Vanilla HTML, CSS, JavaScript
- **Protocol**: MQTT over WebSocket Secure (WSS)
- **Hardware**: ESP32-S3-CAM with OV2640 sensor

---

## Project Structure

```
server/
  config/mqtt.js        MQTT topic definitions and broker config
  db/database.js        SQLite schema and query helpers
  mqtt/client.js        MQTT client, event handlers, binary JPEG storage
  routes/api.js         Express REST API routes
  simulator/            Virtual ESP32 hardware simulator
  server.js             Application entry point
public/
  index.html            Dashboard UI
  css/style.css         Stylesheet
  js/app.js             Frontend application logic
```
