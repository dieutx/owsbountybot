import { getDb } from "../db/database.js";

const INSERT_SQL = `INSERT INTO audit_log (correlation_id, action, entity_type, entity_id, actor, details, ip, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

export function audit({ correlationId, action, entityType, entityId, actor = "system", details = null, ip = null }) {
  const db = getDb();
  db.prepare(INSERT_SQL).run(
    correlationId || null,
    action,
    entityType || null,
    entityId || null,
    actor,
    details ? JSON.stringify(details) : null,
    ip || null,
    new Date().toISOString(),
  );
}

export function getAuditLog({ entityType, entityId, correlationId, limit = 100 } = {}) {
  const db = getDb();
  if (correlationId) {
    return db.prepare("SELECT * FROM audit_log WHERE correlation_id = ? ORDER BY id DESC LIMIT ?").all(correlationId, limit);
  }
  if (entityType && entityId) {
    return db.prepare("SELECT * FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT ?").all(entityType, entityId, limit);
  }
  return db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit);
}
