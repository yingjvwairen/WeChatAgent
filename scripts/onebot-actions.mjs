import { AdapterError } from './desktop-message-delivery.mjs';
import { normalizeDesktopText, validDesktopText } from './desktop-sender/text-contract.mjs';
import { validChatId } from '../packages/wechat-identity.mjs';
const maxActiveActions = 8;
const fail = code => {
  throw new AdapterError(code);
};

export function textSegments(message) {
  if (typeof message === 'string') {
    // Raw OneBot strings may contain CQ segments. This sender only accepts text.
    if (/\[CQ:/i.test(message)) fail('TEXT_SEGMENTS_REQUIRED');
    message = [{ type: 'text', data: { text: message } }];
  }
  if (
    !Array.isArray(message) ||
    !message.length ||
    message.some(s => s?.type !== 'text' || typeof s.data?.text !== 'string')
  )
    fail('TEXT_ONLY');
  const text = normalizeDesktopText(message.map(s => s.data.text).join(''));
  if (!validDesktopText(text)) fail('INVALID_TEXT');
  return text;
}

export async function executeOnebotAction(adapter, request) {
  const response = {
    status: 'failed',
    retcode: 1407,
    data: {},
    ...(request?.echo === undefined ? {} : { echo: request.echo }),
  };
  const action = request?.action,
    params = request?.params ?? {};
  const messageSend = ['send_msg', 'send_private_msg', 'send_group_msg'].includes(action);
  const receiptLookup = messageSend && params.wechatagent_receipt_only === true;
  const intakeAck = action === 'ack_wechatagent_intake';
  let counter =
    receiptLookup || action === 'get_text_delivery' || action === 'get_voice_delivery'
      ? 'activeReceiptActions'
      : 'activeActions';
  // A saved attempt only needs an admission slot once lookup proves the native job is missing.
  const reserveAdmission = () => {
    const active = adapter.activeActions ?? 0;
    if (active >= maxActiveActions) fail('SENDER_BUSY');
    adapter[counter]--;
    counter = 'activeActions';
    adapter[counter] = active + 1;
  };
  // Intake acknowledgements only update the matching in-memory receipt.
  if (!intakeAck) adapter[counter] = (adapter[counter] ?? 0) + 1;
  try {
    if (!intakeAck && adapter[counter] > maxActiveActions) fail('SENDER_BUSY');
    adapter.reload();
    let data;
    if (intakeAck) {
      const pending = adapter.intakePending.get(params.token);
      if (
        !pending ||
        pending.token !== params.token ||
        pending.rawid !== params.rawid ||
        params.self_id !== adapter.ownWxid
      )
        fail('INTAKE_RECEIPT_MISMATCH');
      pending.confirmed = true;
      data = { accepted: true };
    } else if (action === 'get_text_delivery') {
      const kind = params.kind,
        target = params.target,
        id = params.wechatagent_delivery_id;
      if (!validChatId(kind, target) || !/^[a-f0-9]{64}$/.test(id) || !Array.isArray(params.message))
        fail('INVALID_RECEIPT_QUERY');
      const quoted = params.message[0]?.type === 'reply' ? params.message[0].data?.id : undefined;
      const text = textSegments(quoted ? params.message.slice(1) : params.message);
      data = await adapter.send(
        kind,
        target,
        text,
        id,
        null,
        quoted,
        true,
        params.wechatagent_observe_only === true,
        undefined,
        params.wechatagent_roster_grant,
        reserveAdmission,
      );
    } else if (messageSend) {
      const kind =
        action === 'send_group_msg' || (action === 'send_msg' && params.message_type === 'group') ? 'group' : 'private';
      if (action === 'send_msg' && !['group', 'private'].includes(params.message_type)) fail('MESSAGE_TYPE_REQUIRED');
      const target = params[kind === 'group' ? 'group_id' : 'user_id'];
      if (!validChatId(kind, target)) fail('CONVERSATION_NOT_ALLOWED');
      const deliveryId = params.wechatagent_delivery_id;
      if (deliveryId !== undefined && !/^[a-f0-9]{64}$/.test(deliveryId)) fail('INVALID_DELIVERY_ID');
      const quoted = Array.isArray(params.message) && params.message[0]?.type === 'reply';
      const sourceId = quoted ? params.message[0].data?.id : undefined;
      if (quoted && (typeof sourceId !== 'string' || !/^[a-f0-9]{64}$/.test(sourceId))) fail('INVALID_QUOTE_SOURCE');
      const message = quoted ? params.message.slice(1) : params.message;
      const sticker = Array.isArray(message) && message.length === 1 && message[0]?.type === 'wechat_sticker';
      if (params.wechatagent_receipt_only !== undefined && typeof params.wechatagent_receipt_only !== 'boolean')
        fail('INVALID_RECEIPT_QUERY');
      if (
        params.wechatagent_abandon_delivery !== undefined &&
        (typeof params.wechatagent_abandon_delivery !== 'boolean' ||
          (params.wechatagent_abandon_delivery && (!deliveryId || params.wechatagent_receipt_only !== true)))
      )
        fail('INVALID_RECEIPT_QUERY');
      if (
        [params.wechatagent_deadline_at, params.wechatagent_admission_deadline_at].some(
          deadline =>
            deadline !== undefined &&
            (!Number.isSafeInteger(deadline) || deadline < 0 || deadline > Date.now() + 60000),
        )
      )
        fail('INVALID_DELIVERY_DEADLINE');
      if (params.wechatagent_receipt_only === true && (!deliveryId || !sticker)) fail('INVALID_RECEIPT_QUERY');
      if (!receiptLookup && !adapter.allowed(kind, target)) fail('CONVERSATION_NOT_ALLOWED');
      if (params.wechatagent_source !== undefined && params.wechatagent_source !== 'proactive')
        fail('INVALID_SEND_SOURCE');
      if (
        params.wechatagent_source === 'proactive' &&
        (!deliveryId ||
          !/^[a-f0-9]{64}$/.test(params.wechatagent_context_id ?? '') ||
          (params.wechatagent_proactive_expires_at !== undefined &&
            (!Number.isSafeInteger(params.wechatagent_proactive_expires_at) ||
              params.wechatagent_proactive_expires_at < 1 ||
              params.wechatagent_proactive_expires_at > Date.now() + 600000)) ||
          (params.wechatagent_preceding_delivery_id !== undefined &&
            !/^[a-f0-9]{64}$/.test(params.wechatagent_preceding_delivery_id)))
      )
        fail('INVALID_PROACTIVE_CONTEXT');
      const proactive =
        params.wechatagent_source === 'proactive'
          ? {
              contextId: params.wechatagent_context_id,
              expiresAt: params.wechatagent_proactive_expires_at ?? Date.now() + 600000,
              ...(params.wechatagent_preceding_delivery_id
                ? { precedingDeliveryId: params.wechatagent_preceding_delivery_id }
                : {}),
            }
          : null;
      if (sticker) {
        data = await adapter.sendSticker(kind, target, String(message[0].data?.id ?? ''), {
          deliveryId,
          proactive,
          ...(sourceId ? { quoteEventId: sourceId } : {}),
          receiptOnly: params.wechatagent_receipt_only === true,
          deadlineAt: params.wechatagent_deadline_at,
          admissionDeadlineAt: params.wechatagent_admission_deadline_at,
          abandon: params.wechatagent_abandon_delivery === true,
          observeOnly: params.wechatagent_receipt_only === true && params.wechatagent_observe_only === true,
          expectedRosterGrant: params.wechatagent_roster_grant,
          reserveAdmission: receiptLookup ? reserveAdmission : undefined,
        });
      } else {
        const text = textSegments(message);
        data = await adapter.send(
          kind,
          target,
          text,
          deliveryId,
          proactive,
          sourceId,
          false,
          false,
          undefined,
          params.wechatagent_roster_grant,
        );
      }
    } else if (['get_sticker_list', 'get_sticker_labels', 'save_sticker_labels'].includes(action)) {
      const kind = params.kind,
        target = params.target;
      if (!validChatId(kind, target)) fail('INVALID_STICKER_TARGET');
      data =
        action === 'get_sticker_list'
          ? await adapter.stickerList(kind, target, params.query)
          : await adapter.stickerLabels(kind, target, {
              operation: action === 'get_sticker_labels' ? 'read' : 'save',
              ...(action === 'get_sticker_labels' ? { ids: params.ids } : { labels: params.labels }),
            });
    } else if (action === 'get_voice_capability' || action === 'send_voice_text' || action === 'get_voice_delivery') {
      const kind = params.kind,
        target = params.target;
      if (!validChatId(kind, target) || (action !== 'get_voice_delivery' && !adapter.allowed(kind, target)))
        fail('CONVERSATION_NOT_ALLOWED');
      if (action === 'get_voice_capability')
        data = await adapter.voiceSend.capability(kind, target, params.wechatagent_roster_grant);
      else {
        if (!/^[a-f0-9]{64}$/.test(params.wechatagent_delivery_id ?? '') || typeof params.text !== 'string')
          fail('INVALID_DELIVERY_ID');
        data = await adapter.voiceSend.speakReply({
          kind,
          target,
          text: params.text,
          deliveryId: params.wechatagent_delivery_id,
          expectedRosterGrant: params.wechatagent_roster_grant,
          receiptOnly: action === 'get_voice_delivery',
          observeOnly: action === 'get_voice_delivery' && params.wechatagent_observe_only === true,
        });
      }
    } else if (action === 'get_status') {
      const verified = adapter.status.sender_account_verified === true;
      data = { online: verified, good: verified && adapter.status.reader_connected };
    } else if (action === 'get_version_info') {
      data = { app_name: 'WeChatAgent-WeChat-Desktop', app_version: '1', protocol_version: 'wechatagent-ws-v1' };
    } else if (action === 'get_login_info') {
      data = { user_id: (await adapter.checkNative()).selfId, nickname: adapter.project.account.nicknames[0] };
    } else if (['get_friend_list', 'get_group_list'].includes(action)) {
      const kind = action === 'get_group_list' ? 'group' : 'private';
      const sessions = (await adapter.reader('/api/v1/sessions?limit=1000')).sessions ?? [];
      data = sessions
        .filter(row => validChatId(kind, row.username) && adapter.allowed(kind, row.username))
        .map(({ username, displayName = username }) =>
          kind === 'group'
            ? { group_id: username, group_name: displayName }
            : { user_id: username, nickname: displayName, remark: displayName },
        );
    } else fail('ACTION_UNSUPPORTED');
    return { ...response, status: 'ok', retcode: 0, data };
  } catch (error) {
    const code =
      error instanceof AdapterError
        ? error.message
        : error?.message === 'TEXT_DELIVERY_STATE_INVALID'
          ? 'TEXT_DELIVERY_STATE_INVALID'
          : 'BACKEND_UNAVAILABLE';
    adapter.status.last_error = code;
    if (String(request?.action).startsWith('send_')) adapter.status.failed_sends++;
    return {
      ...response,
      data: error instanceof AdapterError && error.data ? error.data : {},
      retcode: code === 'ACTION_UNSUPPORTED' ? 1404 : 1407,
      message: code,
    };
  } finally {
    if (!intakeAck) adapter[counter]--;
  }
}
