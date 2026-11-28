import { appliedPasteResult, fault, id, sameRect } from './qt-contract.mjs';
import { QtActionsClient } from './qt-actions-client.mjs';
import { QtFocusSession } from './qt-focus-session.mjs';
import { QtNavigationSession } from './qt-navigation-session.mjs';
import { QtWindowFrames } from './qt-window-frames.mjs';

// A verified search control can open a conversation before the editor is
// available. No editor, submit or attachment action is exposed in this session.
export async function recoverConversationBySearch({
  root,
  recovery,
  job,
  resolveTarget,
  canInput,
  signal,
  allowClipboardReplacement,
  createClient = options => new QtActionsClient(options),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const { config, binding, accountProbe } = recovery;
  const canNavigate = () => !signal?.aborted && typeof canInput === 'function' && canInput() === true;
  const active = () => {
    if (signal?.aborted) throw fault('UI_QT_CANCELLED', { attempted: false });
    if (!canNavigate()) throw fault('UI_QT_SEARCH_INPUT_NOT_AUTHORIZED', { attempted: false });
  };
  const client = createClient({ root, config, enableInput: true, searchOnly: true, canNavigate });
  const request = (action, values) => {
    active();
    return client.request(action, values);
  };
  const frames = new QtWindowFrames({
    config,
    navigationPolicy: 'pixels-v1',
    request,
    active,
    wait,
    searchOnly: true,
    hasForegroundLease: () => Boolean(focus.preparationLease()),
  });
  const focus = new QtFocusSession({
    root,
    frames,
    native: {
      owner: client,
      request,
      releaseFocus: () => client.request('releaseFocusHandoff'),
      close: () => client.close(),
    },
    active,
    wait,
    onTextRelease: () => {},
    invalidateNavigation: () => {},
  });
  const navigation = new QtNavigationSession({
    frames,
    focus,
    input: {
      active,
      now: Date.now,
      wait,
      checkJob(candidate) {
        active();
        if (candidate?.account !== config.account || !id(candidate.target) || candidate.target === config.account)
          throw fault('UI_QT_PRIVATE_TARGET_REQUIRED');
      },
      resolveTarget,
      allowClipboardReplacement,
      requestNative: request,
      appliedPaste: (result, text) =>
        appliedPasteResult(result, text, frames.transaction?.revision, allowClipboardReplacement),
    },
  });

  try {
    const lookup = await navigation.lookupTarget(job, { signal });
    await focus.acquireForPreparation(
      job,
      { signal },
      {
        warmLocators: async () => {},
        freshAccount: ({ frame }) => accountProbe({ binding: frame.binding, signal }),
        resumableTextStep: () => false,
        now: Date.now,
      },
    );
    const baseline = await frames.capture(['search'], false);
    if (
      !['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi'].every(
        key => baseline.binding[key] === binding[key],
      ) ||
      !sameRect(baseline.binding.clientRect, binding.clientRect) ||
      !sameRect(baseline.binding.captureRect, binding.captureRect)
    )
      throw fault('QT_BINDING_CHANGED', { attempted: false });
    if (baseline.idleMs < config.idleMs) throw fault('UI_USER_ACTIVE', { attempted: false });
    await accountProbe({ binding: baseline.binding, signal });
    frames.bindInputTransaction(baseline);
    const opened = await request('chord', {
      key: 'Control+F',
      ...navigation.popupTransition('search'),
      token: baseline.token,
      epoch: baseline.epoch,
      revision: baseline.revision,
      idleMs: config.idleMs,
    });
    if (opened.performed !== true || opened.attempted !== true || opened.revision !== baseline.revision)
      throw fault('UI_QT_SEARCH_ENTER_UNCERTAIN');
    await navigation.enterSharedSearch(lookup.displayedId, { baseline, searchKind: lookup.searchKind });
  } finally {
    try {
      await focus.releaseTextFocus();
    } finally {
      await client.close();
    }
  }
}
