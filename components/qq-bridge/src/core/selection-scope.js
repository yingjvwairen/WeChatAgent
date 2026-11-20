import crypto from 'node:crypto';

export const SELECTION_SCOPE_CAPABILITY = 'wechat-selection-scope-v1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const username = value => typeof value === 'string' && value.isWellFormed() && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value);
const wireId = value => String(Number(crypto.createHash('sha256').update(value).digest().readBigUInt64BE(0) % 2147483647n + 1n));
const failure = () => Object.assign(new Error('UI_SELECTION_SCOPE_REQUIRED'), { code: 'UI_SELECTION_SCOPE_REQUIRED', attempted: false });

/** Shape only. The sending backend must verify the durable event grant. */
export function validSelectionScope(value) {
  return object(value) && Object.keys(value).length === 8 && value.version === 1 && hex(value.accountRef) && username(value.account) && username(value.target) &&
    value.account !== value.target && !value.account.endsWith('@chatroom') && value.target !== 'filehelper' &&
    typeof value.eventId === 'string' && value.eventId.isWellFormed() && value.eventId.length > 0 && value.eventId.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value.eventId) &&
    Number.isSafeInteger(value.selectionVersion) && value.selectionVersion >= 1 && hex(value.grantId) && hex(value.token);
}
export function selectionScopeFields(message) {
  if (message.ui_selection_required === undefined && message.ui_reply_scope === undefined) return {};
  const scope = message.ui_reply_scope;
  if (message.ui_selection_required !== true || !validSelectionScope(scope) || message.platform !== 'wechat' || message.kind !== (scope.target.endsWith('@chatroom') ? 'group' : 'private') ||
      String(message.self_id) !== wireId(scope.account) || String(message.conversation_id) !== wireId(scope.target)) throw failure();
  return { ui_selection_required: true, ui_reply_scope: Object.freeze(structuredClone(scope)) };
}
export function sameSelectionEpoch(left, right) {
  const a = selectionScopeFields(left).ui_reply_scope, b = selectionScopeFields(right).ui_reply_scope;
  return !a && !b || !!a && !!b && ['accountRef', 'account', 'target', 'grantId'].every(key => a[key] === b[key]);
}
