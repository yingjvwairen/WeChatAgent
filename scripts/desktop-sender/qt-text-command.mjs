import crypto from 'node:crypto';
import { fault, object } from './qt-contract.mjs';

export function nativeTextProof(value, text) {
  if (
    !object(value) ||
    Object.keys(value).length !== 3 ||
    value.version !== 1 ||
    !/^[a-f0-9]{32}$/.test(value.id ?? '') ||
    value.textSha256 !== crypto.createHash('sha256').update(text).digest('hex')
  )
    throw fault('UI_QT_TEXT_ENTER_PROOF_INVALID');
  return structuredClone(value);
}

export function textCommand(
  action,
  text,
  current,
  frame,
  { config, allowClipboardReplacement, foregroundOnly, stepBinding },
) {
  const typed = action === 'type' && current.shared === true && current.draftPolicy === 'unchecked';
  const enterSubmit = action === 'submit' && current.shared === true;
  const values = { token: frame.token, epoch: frame.epoch, revision: frame.revision, idleMs: config.idleMs };
  if (current.quoteToken) values.quoteToken = current.quoteToken;
  let name = action;
  if (enterSubmit || typed || (action === 'paste' && current.shared)) {
    Object.assign(values, {
      headerRect: config.layout.header,
      editorRect: config.layout.editor,
      stepBinding: stepBinding(),
    });
  }
  if (action === 'submit') {
    name = enterSubmit ? 'submitTextEnter' : 'click';
    if (enterSubmit) {
      const proof = nativeTextProof(current.textEnterProof, current.draft);
      Object.assign(values, {
        sendKey: config.sendKey ?? 'enter',
        textEnterProofId: proof.id,
        textSha256: proof.textSha256,
      });
    } else values.rect = config.layout.send;
  } else if (action === 'paste') {
    Object.assign(values, { scope: 'editor', text, expectedText: current.draft + text, allowClipboardReplacement });
    if (current.shared && current.draftPolicy === 'unchecked') {
      values.readback = false;
      if (foregroundOnly) values.foregroundOnly = true;
    }
  } else {
    values.text = text;
    if (typed) {
      name = 'typeText';
      values.expectedText = current.draft + text;
      if (foregroundOnly) values.foregroundOnly = true;
      if (current.draft) values.textEnterProofId = nativeTextProof(current.textEnterProof, current.draft).id;
    }
    if (text === '\n') values.newlineKey = config.newlineKey;
  }
  return { typed, enterSubmit, name, values };
}
