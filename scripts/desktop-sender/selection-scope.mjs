const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const username = value =>
  typeof value === 'string' &&
  value.isWellFormed() &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\u0000-\u0020\u007f]/u.test(value);

/** Shape only. The sending backend must verify the durable event grant. */
export function validSelectionScope(value) {
  return (
    object(value) &&
    Object.keys(value).length === 8 &&
    value.version === 1 &&
    hex(value.accountRef) &&
    username(value.account) &&
    username(value.target) &&
    value.account !== value.target &&
    !value.account.endsWith('@chatroom') &&
    typeof value.eventId === 'string' &&
    value.eventId.isWellFormed() &&
    value.eventId.length > 0 &&
    value.eventId.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value.eventId) &&
    Number.isSafeInteger(value.selectionVersion) &&
    value.selectionVersion >= 1 &&
    hex(value.grantId) &&
    hex(value.token)
  );
}
