import test from 'node:test';
import assert from 'node:assert/strict';
import { QtAttachmentSession } from './qt-attachment-session.mjs';

const queuedImage = {
  performed: true,
  attempted: true,
  submitted: false,
  inputQueued: true,
  submissionConfirmed: false,
  revision: 7,
  pointerDelivery: {
    version: 1,
    method: 'window-message-v1',
    scope: 'image-submit',
    messagesPosted: 3,
    queueAccepted: true,
    systemCursorMovementRequested: false,
    cursorUnchanged: true,
    completion: 'receipt-pending',
  },
};

function submissionFixture({ layoutMode = 'uia-v1', format = 'static', requestNative, releaseFocus }) {
  const frame = { token: 'frame', epoch: 'epoch', revision: 7, regions: [{ rgbaSha256: 'header' }] };
  const lease = {};
  const job = {
    id: 'd'.repeat(64),
    mode: format === 'file' ? 'file' : 'image',
    image: { sha256: 'b'.repeat(64), format },
  };
  const current = {
    jobId: job.id,
    revision: frame.revision,
    editorToken: 'editor',
    header: 'header',
    imageApplied: job.id,
    imageSha256: job.image.sha256,
    imageFormat: format === 'static' ? undefined : format,
    ...(format === 'file' ? { fileDialogProof: { id: 'c'.repeat(32), sha256: job.image.sha256 } } : {}),
    uiaImageFrame: frame,
    uiaImageProof: { version: 1, id: 'a'.repeat(32), imageSha256: job.image.sha256, imageFormat: format },
  };
  let focusReturns = 0;
  const driver = {
    frame,
    current,
    allowSubmit: true,
    config: { layoutMode, idleMs: 1000, layout: { send: {} } },
    capture: async () => frame,
    checkJob() {},
    active() {},
    preparationLease: () => lease,
    verifyControlBinding: async () => {},
    beginImageSubmission(item) {
      assert.equal(item, job);
      this.imageSubmitAttempted = item.id;
    },
    refuseImageSubmission(item) {
      assert.equal(this.imageSubmitAttempted, item.id);
      this.imageSubmitAttempted = null;
    },
    discardDraft() {
      this.current = null;
    },
    requestNative,
    releaseTextFocus: async () => {
      focusReturns++;
      await releaseFocus?.();
    },
  };
  const session = new QtAttachmentSession({ input: driver, frames: driver, focus: driver });
  session.acceptUiaImageFrame = value => value;
  const guard = { editorToken: current.editorToken, activityRevision: current.revision, canSubmit: () => true };
  return {
    current,
    driver,
    job,
    get focusReturns() {
      return focusReturns;
    },
    submit: (options = {}) => session.submitImage(job, guard, options),
  };
}

test('UIA attachment submission requires the current native queue proof', async () => {
  for (const [response, deferFocusRelease] of [
    [queuedImage, false],
    [{ performed: true, attempted: true, submitted: true, revision: 7 }, false],
    [{ ...queuedImage, pointerDelivery: null }, false],
    [{ ...queuedImage, inputReleased: true }, true],
  ]) {
    const f = submissionFixture({
      requestNative: async () => response,
      releaseFocus: () => {
        if (deferFocusRelease) throw Error('focus return failed');
      },
    });
    const request = f.submit({ deferFocusRelease });
    if (deferFocusRelease) assert.deepEqual(await request, { performed: true, attempted: true, inputReleased: true });
    else if (response === queuedImage) assert.deepEqual(await request, { performed: true, attempted: true });
    else await assert.rejects(request, { code: 'UI_QT_IMAGE_SUBMIT_UNCONFIRMED' });
    assert.equal(f.focusReturns, deferFocusRelease ? 0 : 1);
  }
});

for (const [layoutMode, format, command] of [
  ['adaptive-v1', 'static', 'submitOcrMedia'],
  ['uia-v1', 'static', 'submitUiaImage'],
  ['uia-v1', 'gif', 'submitUiaImage'],
  ['uia-v1', 'file', 'submitFileDialog'],
]) {
  test(`a native pre-input refusal preserves the original attachment draft in ${layoutMode} for ${format}`, async () => {
    let calls = 0;
    const f = submissionFixture({
      layoutMode,
      format,
      async requestNative(action) {
        assert.equal(action, command);
        if (++calls === 1)
          throw Object.assign(Error('native guard refusal'), {
            code: 'QT_USER_ACTIVE',
            nativeAction: action,
            attempted: false,
            clipboardRestored: false,
          });
        assert.equal(f.driver.current, f.current);
        const sent = { performed: true, attempted: true, revision: f.current.revision };
        if (command === 'submitFileDialog') return { ...sent, inputQueued: true, dialogClosed: true };
        if (command === 'submitOcrMedia') return { ...sent, controlConsumed: true };
        return { ...queuedImage, inputReleased: true };
      },
    });
    assert.deepEqual(await f.submit({ deferFocusRelease: true }), {
      performed: false,
      attempted: false,
      reason: 'QT_USER_ACTIVE',
    });
    assert.equal(f.driver.imageSubmitAttempted, null);
    assert.equal(f.driver.current, f.current);
    assert.deepEqual(await f.submit({ deferFocusRelease: true }), {
      performed: true,
      attempted: true,
      inputReleased: true,
    });
    assert.equal(f.driver.imageSubmitAttempted, f.job.id);
    assert.equal(calls, 2);
  });
}

test('attachment errors without matching no-input proof fence a second native call', async () => {
  for (const details of [{ nativeAction: 'submitUiaImage' }, { nativeAction: 'inspectLayout', attempted: false }]) {
    const error = Object.assign(Error('native submission outcome unavailable'), details);
    let calls = 0;
    const f = submissionFixture({
      requestNative: async () => {
        calls++;
        throw error;
      },
    });
    await assert.rejects(f.submit({ deferFocusRelease: true }), caught => caught === error);
    assert.equal(f.driver.imageSubmitAttempted, f.job.id);
    await assert.rejects(f.submit({ deferFocusRelease: true }), { code: 'UI_QT_IMAGE_SUBMIT_UNCONFIRMED' });
    assert.equal(calls, 1);
  }
});
