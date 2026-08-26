const { createHash } = require("node:crypto");

const CURSOR_EVENT_KEY_PREFIX = "cursor:v2:";

function cursorIdentityParts(event) {
  return [
    String(event?.timestamp ?? ""),
    String(event?.model ?? "unknown"),
    String(event?.conversationId ?? event?.conversation_id ?? event?.conversationID ?? ""),
  ];
}

function cursorEventKeyFromParts(parts) {
  const identity = parts.slice(0, 3).map((value) => String(value ?? "")).join("\u001f");
  return `${CURSOR_EVENT_KEY_PREFIX}${createHash("sha256").update(identity).digest("hex")}`;
}

function cursorEventKey(event) {
  return cursorEventKeyFromParts(cursorIdentityParts(event));
}

function cursorEventKeyFromLegacy(legacyKey) {
  const value = String(legacyKey || "");
  if (value.startsWith(CURSOR_EVENT_KEY_PREFIX)) return value;
  const parts = value.split("|");
  if (parts.length < 3) return null;
  return cursorEventKeyFromParts(parts);
}

module.exports = {
  CURSOR_EVENT_KEY_PREFIX,
  cursorEventKey,
  cursorEventKeyFromLegacy,
};
