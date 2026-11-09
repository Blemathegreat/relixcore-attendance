export async function writeAudit(
  executor,
  { actorId, action, entityType, entityId = null, targetUserId = null, reason = null, oldValues = null, newValues = null, ip = null },
) {
  await executor.execute(
    `INSERT INTO audit_logs
       (actor_id, action, entity_type, entity_id, target_user_id, reason, old_values, new_values, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      actorId,
      action,
      entityType,
      entityId,
      targetUserId,
      reason,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      ip,
    ],
  );
}
