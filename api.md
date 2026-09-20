ESP32-S3 Smart Lock — Developer API Documentation
1. Overview
This document describes the current communication interface for the ESP32-S3 smart-lock firmware and the REST log-processing backend.
The system has two API layers:
MQTT — device commands and device events.
REST — upload and retrieval of SD-card logs and the registered-user metadata file.
The REST service returns JSON only. It does not provide or generate an HTML page.
---
2. MQTT API
2.1 Broker
```text
WSS: wss://iot.coreflux.cloud:443/mqtt
Port: 443
Protocol: MQTT over WebSocket Secure
```
The ESP32 uses a unique client ID derived from the ESP32 eFuse MAC address.
Example:
```text
ESP32CAM_XXXXXXXX
```
---
2.2 MQTT Command Topics
Purpose	Topic	Direction
Register user	`847291/583104/command/register`	Backend → ESP32
Delete user	`847291/583104/command/delete`	Backend → ESP32
Manual unlock	`847291/583104/command/unlock`	Backend → ESP32
---
2.3 Register User
Topic
```text
847291/583104/command/register
```
Payload
```json
{
  "id": 1,
  "name": "Ajeth"
}
```
Required fields
Field	Type	Description
`id`	integer	Application-level user ID
`name`	string	Registered user's display name
The ESP32 captures the configured number of face embeddings and stores them in its face database.
Registration event topic
```text
847291/583104/event/registration
```
Possible status values include:
```text
capturing
success
failed
```
Example progress event:
```json
{
  "id": 1,
  "name": "Ajeth",
  "status": "capturing",
  "embedding": 3,
  "total": 10
}
```
Example success event:
```json
{
  "id": 1,
  "name": "Ajeth",
  "status": "success",
  "embeddings": 10
}
```
Failure events include a `reason`, for example:
```text
id_already_registered
database_full
face_not_detected
database_save_failed
```
The firmware adds common event metadata to outgoing MQTT events where applicable:
```json
{
  "device_id": "ESP32CAM_XXXXXXXX",
  "timestamp": "2026-09-19T21:55:24Z",
  "timestamp_epoch": 1789854924
}
```
`timestamp` is UTC ISO-8601. If NTP synchronization has not succeeded, the firmware records a null timestamp and marks the source as `unsynchronized`.
---
2.4 Delete User
Topic
```text
847291/583104/command/delete
```
Payload
```json
{
  "id": 1
}
```
Required fields
Field	Type	Description
`id`	integer	User ID to remove
Deletion event topic
```text
847291/583104/event/deletion
```
Example success:
```json
{
  "id": 1,
  "status": "success"
}
```
Example failure:
```json
{
  "id": 1,
  "status": "failed",
  "reason": "user_not_found"
}
```
Possible failure reasons include:
```text
user_not_found
database_save_failed
```
---
3. Manual Unlock API
3.1 MQTT unlock command
Manual unlock is implemented as an MQTT command, not an HTTP endpoint.
Topic
```text
847291/583104/command/unlock
```
Payload
The payload may be empty or `{}`.
Recommended:
```json
{}
```
The ESP32 queues the command and, once it is safe to execute, unlocks the door using:
```text
source = manual
```
The same automatic relock timer is used as for face authentication.
Current behavior:
```text
GPIO 2 HIGH → UNLOCKED
GPIO 2 LOW  → LOCKED
```
The automatic relock timeout is:
```text
10 seconds
```
Lock event topic
```text
847291/583104/event/lock
```
Manual unlock example:
```json
{
  "status": "unlocked",
  "source": "manual"
}
```
Automatic relock example:
```json
{
  "status": "locked",
  "source": "auto"
}
```
Face-authenticated unlock uses:
```json
{
  "status": "unlocked",
  "source": "face"
}
```
> There is currently **no REST `POST /unlock` endpoint**. Manual unlock is intentionally exposed through the MQTT command topic.
---
4. Authentication Events
4.1 Authentication event topic
```text
847291/583104/event/auth
```
The physical authentication flow is initiated by the button on GPIO 1.
The current face-recognition pipeline uses MNP01 five-point landmarks followed by five-point similarity alignment and the 112×112 face-recognition model.
---
4.2 Authorized event
Example:
```json
{
  "status": "authorized",
  "id": 1,
  "name": "Ajeth",
  "similarity": 0.7481,
  "first_similarity": 0.7498,
  "second_similarity": 0.7481,
  "threshold": 0.60,
  "embedding_delta": 0.081777,
  "source": "face"
}
```
Fields
Field	Type	Description
`status`	string	`authorized`
`id`	integer	Matched registered user ID
`name`	string	Matched registered user name
`similarity`	number	Lower of the two verification similarities
`first_similarity`	number	First-frame profile similarity
`second_similarity`	number	Second-frame profile similarity
`threshold`	number	Configured authentication threshold
`embedding_delta`	number	Maximum absolute difference between first and second embeddings
`source`	string	`face`
The first and second similarities are calculated against the selected user's registered embeddings using the same profile-averaging method.
---
4.3 Denied event
Example:
```json
{
  "status": "denied",
  "id": -1,
  "name": "",
  "similarity": 0.5234,
  "verification_similarity": 0.5234,
  "first_similarity": 0.5234,
  "second_similarity": null,
  "threshold": 0.60,
  "embedding_delta": 0.0,
  "image_topic": "847291/583104/event/auth/image",
  "image_format": "image/jpeg",
  "intruder_image_stored_on_sd": false,
  "reason": "identity_not_recognized"
}
```
When a face is detected but the identity is not accepted, the firmware can also provide:
```json
"candidate_id": 1,
"candidate_name": "Ajeth"
```
when a candidate user was selected during matching.
---
4.4 Second-frame verification
The first frame must pass the threshold before a fresh second frame is captured.
The second frame is then processed independently and compared against the same selected user.
A missing second-frame result is represented as:
```json
"second_similarity": null
```
not as a valid similarity score.
This can happen when a usable five-point face cannot be obtained from the second frame.
---
4.5 Intruder image event
Topic
```text
847291/583104/event/auth/image
```
The intruder image is transmitted as JPEG data through MQTT.
The firmware does not store the intruder/denied image on the SD card.
The authentication JSON explicitly exposes:
```json
"intruder_image_stored_on_sd": false
```
---
5. SD Card API Data
The ESP32 stores the following application files:
```text
/esp32/face_db.bin
/esp32/events.jsonl
/esp32/registered_users.json
```
5.1 `face_db.bin`
Binary face database containing the registered face embeddings.
This file is an internal ESP32 file and is not exposed through the REST API.
---
5.2 `events.jsonl`
Structured JSON Lines event log.
Each line is one independent JSON object.
Example MQTT log record:
```json
{
  "topic": "847291/583104/event/auth",
  "payload": {
    "device_id": "ESP32CAM_XXXXXXXX",
    "timestamp": "2026-09-19T21:55:24Z",
    "timestamp_epoch": 1789854924,
    "status": "authorized",
    "id": 1,
    "name": "Ajeth",
    "first_similarity": 0.7498,
    "second_similarity": 0.7481,
    "threshold": 0.60,
    "embedding_delta": 0.081777,
    "source": "face"
  }
}
```
System events may instead contain an `event` field directly, for example:
```json
{
  "device_id": "ESP32CAM_XXXXXXXX",
  "timestamp": "2026-09-19T21:55:24Z",
  "timestamp_epoch": 1789854924,
  "event": "system_ready"
}
```
---
5.3 `registered_users.json`
User metadata for the frontend.
The embeddings themselves are deliberately excluded.
Example:
```json
{
  "device_id": "ESP32CAM_XXXXXXXX",
  "user_count": 2,
  "updated_at": "2026-09-19T21:55:24Z",
  "updated_at_epoch": 1789854924,
  "users": [
    {
      "id": 1,
      "name": "Ajeth",
      "embedding_count": 10
    },
    {
      "id": 2,
      "name": "OBAMA",
      "embedding_count": 10
    }
  ]
}
```
The file is regenerated when the face database is successfully updated.
---
6. REST API
The REST service is JSON-only.
Default server:
```text
http://localhost:3000
```
The port can be changed with:
```text
PORT=3000
```
The display timezone defaults to:
```text
Asia/Kolkata
```
and can be changed with:
```text
DISPLAY_TZ=UTC
```
---
6.1 Health Check
Request
```http
GET /api/smart-lock/logs/health
```
Response
```json
{
  "ok": true,
  "service": "smart-lock-log-processor",
  "display_timezone": "Asia/Kolkata"
}
```
---
6.2 Process SD Event Log
Request
```http
POST /api/smart-lock/logs
Content-Type: multipart/form-data
```
Multipart field:
```text
file = events.jsonl
```
cURL
```bash
curl -F "file=@events.jsonl" \
  http://localhost:3000/api/smart-lock/logs
```
Response structure
```json
{
  "ok": true,
  "filename": "events.jsonl",
  "size_bytes": 12345,
  "timezone_for_display": "Asia/Kolkata",
  "total_records": 42,
  "parse_errors": [],
  "devices": [
    "ESP32CAM_XXXXXXXX"
  ],
  "summary": {
    "authentication_total": 8,
    "authentication_authorized": 5,
    "authentication_denied": 3,
    "authentication_no_face": 1,
    "lock_unlocked": 5,
    "lock_locked": 5,
    "registration_success": 2,
    "registration_failed": 0,
    "deletion_success": 1,
    "deletion_failed": 0,
    "mqtt_commands": 3,
    "average_auth_score": 0.7421
  },
  "latest": [],
  "registered_users": []
}
```
The `latest` array contains up to the most recent processed events.
Typical normalized event fields are:
```text
timestamp
timestamp_display
type
topic
status
id
name
source
first_similarity
second_similarity
similarity
threshold
embedding_delta
reason
```
The backend ignores negative/non-numeric similarity values when calculating the average authentication score.
Error: no file
```http
400 Bad Request
```
```json
{
  "ok": false,
  "error": "Upload events.jsonl as multipart/form-data with field name 'file'."
}
```
---
6.3 Upload Registered Users
Request
```http
POST /api/smart-lock/users
Content-Type: multipart/form-data
```
Multipart field:
```text
file = registered_users.json
```
cURL
```bash
curl -F "file=@registered_users.json" \
  http://localhost:3000/api/smart-lock/users
```
Response
```json
{
  "ok": true,
  "filename": "registered_users.json",
  "device_id": "ESP32CAM_XXXXXXXX",
  "user_count": 2,
  "updated_at": "2026-09-19T21:55:24Z",
  "updated_at_display": "19/09/2026, 03:25:24",
  "updated_at_epoch": 1789854924,
  "users": [
    {
      "id": 1,
      "name": "Ajeth",
      "embedding_count": 10
    },
    {
      "id": 2,
      "name": "OBAMA",
      "embedding_count": 10
    }
  ]
}
```
---
6.4 Get Latest Registered Users
This endpoint returns the most recently uploaded user metadata held by the REST server.
Request
```http
GET /api/smart-lock/users
```
Response
```json
{
  "ok": true,
  "device_id": "ESP32CAM_XXXXXXXX",
  "user_count": 2,
  "updated_at": "2026-09-19T21:55:24Z",
  "updated_at_display": "19/09/2026, 03:25:24",
  "updated_at_epoch": 1789854924,
  "users": [
    {
      "id": 1,
      "name": "Ajeth",
      "embedding_count": 10
    },
    {
      "id": 2,
      "name": "OBAMA",
      "embedding_count": 10
    }
  ]
}
```
If no users file has been uploaded since the server started, the endpoint returns an empty user list.
---
7. Frontend Integration Flow
A typical frontend synchronization flow is:
```text
ESP32 SD card
    |
    +--> events.jsonl ---------------------> POST /api/smart-lock/logs
    |                                               |
    |                                               +--> statistics
    |                                               +--> latest events
    |
    +--> registered_users.json -------------> POST /api/smart-lock/users
                                                    |
                                                    +--> GET /api/smart-lock/users
```
For live control:
```text
Frontend/backend
      |
      +--> MQTT command/register
      +--> MQTT command/delete
      +--> MQTT command/unlock

ESP32
      |
      +--> MQTT event/registration
      +--> MQTT event/deletion
      +--> MQTT event/auth
      +--> MQTT event/auth/image
      +--> MQTT event/lock
```
---
8. Important Current Behavior
Face authentication
Authentication is started by the physical button on GPIO 1.
Lock state
```text
GPIO 2 LOW  = LOCKED
GPIO 2 HIGH = UNLOCKED
```
Automatic relock
```text
10 seconds
```
Face threshold
Current firmware configuration:
```text
FACE_THRESHOLD = 0.60
```
Second-frame verification
The current authentication flow uses two fresh face embeddings when the first profile match passes the threshold.
`second_similarity` is nullable when the second frame does not produce a valid face embedding.
SD image storage
Intruder/denied images are not stored on SD.
REST response format
The REST service returns JSON. There is no HTML report endpoint in the current API contract.
---
9. Quick Reference
MQTT commands
```text
REGISTER
847291/583104/command/register
{"id":1,"name":"Ajeth"}

DELETE
847291/583104/command/delete
{"id":1}

UNLOCK
847291/583104/command/unlock
{}
```
MQTT events
```text
847291/583104/event/registration
847291/583104/event/deletion
847291/583104/event/lock
847291/583104/event/auth
847291/583104/event/auth/image
```
REST endpoints
```text
GET  /api/smart-lock/logs/health
POST /api/smart-lock/logs
POST /api/smart-lock/users
GET  /api/smart-lock/users
```