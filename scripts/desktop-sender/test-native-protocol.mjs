import test from 'node:test';
import assert from 'node:assert/strict';
import { QtAttachmentSession } from './qt-attachment-session.mjs';

test('UIA attachment submission requires the current native queue proof', async () => {
  const queued = {
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
  for (const response of [
    queued,
    { performed: true, attempted: true, submitted: true, revision: 7 },
    { ...queued, pointerDelivery: null },
  ]) {
    const frame = { token: 'frame', epoch: 'epoch', revision: 7 },
      lease = {};
    const job = { id: 'job', image: { sha256: 'b'.repeat(64) } };
    const current = {
      revision: 7,
      uiaImageFrame: frame,
      uiaImageProof: { version: 1, id: 'a'.repeat(32), imageSha256: job.image.sha256, imageFormat: 'static' },
    };
    let released = 0;
    const driver = {
      frame,
      invalidateFrame() {
        this.frame = null;
      },
      current,
      beginImageSubmission(value) {
        assert.equal(value, job);
      },
      discardDraft() {
        this.current = null;
        this.invalidateFrame();
      },
      config: { idleMs: 1000 },
      preparationLease: () => lease,
      verifyControlBinding: async () => {},
      active() {},
      requestNative: async () => response,
      releaseTextFocus: async () => released++,
    };
    const attachments = new QtAttachmentSession({ input: driver, frames: driver, focus: driver });
    attachments.acceptUiaImageFrame = value => value;
    const request = attachments.submitUiaImage(job, { canSubmit: () => true }, current);
    if (response === queued) assert.deepEqual(await request, { performed: true, attempted: true });
    else await assert.rejects(request, { code: 'UI_QT_IMAGE_SUBMIT_UNCONFIRMED' });
    assert.equal(released, 1);
  }
});
