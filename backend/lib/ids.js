import crypto from "crypto";

export function generateId(prefix = "") {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return prefix ? `${prefix}-${ts}-${rand}` : `${ts}-${rand}`;
}

export function correlationId() {
  return crypto.randomUUID();
}
