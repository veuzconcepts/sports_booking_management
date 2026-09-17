/**
 * Display the actor of a timeline / audit entry, the way Salesforce or Odoo do:
 *   - "You"  when the action was performed by the currently logged-in user
 *   - the person's full name for anyone else
 *   - "System" when no actor was recorded (automated or seed/imported data)
 *
 * @param {number|string|null} changedById   actor's user id on the entry
 * @param {string|null}        changedByName actor's full name on the entry
 * @param {number|string|null} currentUserId the logged-in user's id
 */
export function actorLabel(changedById, changedByName, currentUserId) {
  if (
    changedById != null && currentUserId != null
    && String(changedById) === String(currentUserId)
  ) {
    return 'You';
  }
  return changedByName || 'System';
}
