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
  const clauses = [];
  const params = [];

  if (correlationId) {
    clauses.push("correlation_id = ?");
    params.push(correlationId);
  }
  if (entityType) {
    clauses.push("entity_type = ?");
    params.push(entityType);
  }
  if (entityId) {
    clauses.push("entity_id = ?");
    params.push(entityId);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`).all(...params, limit);
}
