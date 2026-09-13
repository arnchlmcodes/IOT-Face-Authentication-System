const MQTT_TOPICS = {
  namespace: "847291/583104/",
  brokerUrl: process.env.MQTT_BROKER_URL || "wss://iot.coreflux.cloud:443/mqtt",

  // Commands (Backend -> ESP32)
  commandRegister: "847291/583104/command/register",
  commandDelete: "847291/583104/command/delete",

  // Events (ESP32 -> Backend)
  eventRegistration: "847291/583104/event/registration",
  eventDeletion: "847291/583104/event/deletion",
  eventAuth: "847291/583104/event/auth",
  eventAuthImage: "847291/583104/event/auth/image",

  // Subscription pattern
  eventSubscription: "847291/583104/event/#",

  // Optional future topics
  commandStatus: "847291/583104/command/status",
  eventHeartbeat: "847291/583104/event/heartbeat"
};

module.exports = MQTT_TOPICS;
