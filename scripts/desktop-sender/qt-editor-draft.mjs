import {
  fault,
  sameHeaderView,
  observedLayout,
  preparationWaits,
  codeFor,
  qtEmptyEditorHashes,
  validateQtEmptyDraftPhaseProof,
  validateQtEmptyDraftPhase,
} from './qt-contract.mjs';
import { nativeTextProof } from './qt-text-command.mjs';
import { inspectEditorPixels } from './qt-auto-layout.mjs';

export class QtEditorDraft {
  /** @param {import('./qt-window-frames.mjs').QtWindowFrames} frames
   * @param {import('./qt-focus-session.mjs').QtFocusSession} focus
   * @param {Pick<import('./qt-visual-driver.mjs').QtVisualDriver,'action'|'active'|'requestNative'|'textStepBinding'|'verifyControlBinding'|'current'|'discardNativeFrameImage'|'root'|'operationSignal'>} input */
  constructor(frames, focus, input) {
    this.frames = frames;
    this.focus = focus;
    this.input = input;
  }
  async verifyNew(job, verified, signal) {
    // Input after this point may paste or submit. Acquire an empty editor once,
    // before attaching our quote. Continuations retain their own bound prefix.
    if (!verified.draft && !job.pendingInput && job.mode !== 'voice') {
      if (this.frames.config.layoutMode === 'uia-v1') {
        const { token, epoch, revision } = verified.frame;
        const check = await this.input.requestNative('checkClearMessageQuote', {
          token,
          epoch,
          revision,
          idleMs: this.frames.config.idleMs,
        });
        if (check.clear !== true) throw fault('UI_QT_EXISTING_DRAFT');
      } else {
        const observed = await this.readDraft(job);
        if (observed.draft !== '') throw fault('UI_QT_EXISTING_DRAFT');
        if (this.frames.regionDigest(observed.frame, 0) !== this.frames.regionDigest(verified.frame, 0))
          throw fault('UI_QT_HEADER_CHANGED');
        Object.assign(verified, observed);
      }
      await this.input.verifyControlBinding(job, verified.frame, 'prepare', signal);
    }
  }
  async readDraft(job) {
    // Moving away from the editor removes its hover/placeholder variation.
    // This is a fresh guarded move only: the editor keeps keyboard focus and
    // the native empty-template observation retains its original time limit.
    const pointerParkRect = this.frames.config.layout.pointerParkRect ?? this.frames.config.layout.focusActivateRect;
    if (pointerParkRect) {
      const parked = await this.input.action(
        'movePointer',
        {
          rect: pointerParkRect,
        },
        [pointerParkRect],
      );
      if (parked.performed !== true || parked.pointerParked !== true || parked.focusPreserved !== true)
        throw fault('UI_QT_POINTER_PARK_UNCONFIRMED');
    }
    // The read operation verifies the complete copied text/companions (or an
    // exact empty-editor template). Anchoring it to a caret bitmap would reject
    // an otherwise unchanged editor on every blink. Submission still anchors
    // the editor returned by the fresh post-read capture below.
    const layout = this.frames.config.layout;
    let verifiedEmptyHashes = qtEmptyEditorHashes(layout);
    const currentDraft = this.input.current;
    if (!verifiedEmptyHashes.length && currentDraft?.jobId === job?.id)
      verifiedEmptyHashes = currentDraft?.verifiedEmptyHashes ?? [];
    let measured;
    if (!verifiedEmptyHashes.length) {
      measured = await this.frames.capture(['header', 'editor'], true);
      try {
        verifiedEmptyHashes = await inspectEditorPixels({
          root: this.input.root,
          frame: measured,
          header: layout.header,
          editor: layout.editor,
          signal: this.input.operationSignal,
        });
      } finally {
        this.input.discardNativeFrameImage(measured);
      }
    }
    const frame = await this.frames.capture(['header']);
    if (measured && !sameHeaderView(measured, frame)) throw fault('UI_QT_HEADER_CHANGED');
    let result;
    try {
      result = await this.input.requestNative('readDraft', {
        token: frame.token,
        epoch: frame.epoch,
        revision: frame.revision,
        idleMs: this.frames.config.idleMs,
        editorRect: this.frames.config.layout.editor,
        ...(observedLayout(this.frames.config) && this.focus.preparationLease()
          ? {
              headerRect: this.frames.config.layout.header,
              ...(job
                ? {
                    stepBinding: this.input.textStepBinding(job),
                  }
                : {}),
            }
          : {}),
        emptyEditorSha256: verifiedEmptyHashes[0],
        emptyEditorSha256s: verifiedEmptyHashes,
      });
    } catch (error) {
      if (preparationWaits.has(codeFor(error)) && error?.attempted !== false && error?.clipboardRestored !== true)
        throw fault('UI_QT_CLEANUP_UNCONFIRMED');
      throw error;
    }
    this.frames.invalidateFrame();
    if (
      result.draftVerified !== true ||
      result.clipboardRestored !== true ||
      typeof result.draft !== 'string' ||
      result.draft.length > 16000 ||
      result.revision !== this.frames.transaction.revision ||
      (result.draft === '' && result.emptyTemplateMatched !== true)
    )
      throw fault('UI_QT_DRAFT_UNVERIFIED');
    const emptyDraftPhaseProof =
      result.draft === ''
        ? validateQtEmptyDraftPhaseProof(
            result.emptyDraftPhaseProof,
            this.frames.config.layout.editor,
            verifiedEmptyHashes,
          )
        : undefined;
    if (emptyDraftPhaseProof && result.richContentVerified !== true) throw fault('UI_QT_EMPTY_PHASE_PROOF_INVALID');
    const shared = observedLayout(this.frames.config) && Boolean(this.focus.preparationLease()),
      current =
        shared && result.draft !== ''
          ? this.frames.acceptPostPasteFrame(result.postPasteFrame, frame, ['header', 'editor'])
          : await this.frames.capture(['header', 'editor']);
    const verifiedEmptyPhase =
      emptyDraftPhaseProof && !verifiedEmptyHashes.includes(current.regions[1].rgbaSha256)
        ? await this.inspectEmptyDraftPhase(current, emptyDraftPhaseProof)
        : undefined;
    const draft = result.draft.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return {
      draft,
      frame: current,
      ...(shared && draft !== ''
        ? {
            textEnterProof: nativeTextProof(result.textEnterProof, draft),
          }
        : {}),
      ...(draft === ''
        ? {
            verifiedEmptyHashes: Object.freeze([...verifiedEmptyHashes]),
            emptyDraftPhaseProof,
            verifiedEmptyPhase,
          }
        : {}),
    };
  }
  async inspectEmptyDraftPhase(frame, proof) {
    this.input.active();
    this.frames.assertTransaction(frame);
    const value = await this.input.requestNative('inspectEmptyEditorPhase', {
      token: frame.token,
      epoch: frame.epoch,
      revision: frame.revision,
      idleMs: this.frames.config.idleMs,
      emptyDraftPhaseProofId: proof.id,
    });
    this.input.active();
    return validateQtEmptyDraftPhase(value, proof, frame);
  }
}
