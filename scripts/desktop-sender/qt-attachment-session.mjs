import {
  clipboardSettled,
  codeFor,
  fault,
  hash,
  object,
  rect,
  sameRect,
  validConversationFingerprint,
  validFocusHandoff,
  validForegroundSession,
  validUiaImageProof,
  validUiaPointerDelivery,
} from './qt-contract.mjs';
import { clipboardFailureDiagnostic, clipboardOutcome } from './qt-diagnostics.mjs';
import { isDeepStrictEqual } from 'node:util';
import { validateAccountEvidence } from './account-probe.mjs';
import path from 'node:path';

// Stateless operations over the driver's shared window and input session.
class QtAttachmentSession {
  /** @type {ReturnType<typeof import('./qt-session-access.mjs').attachmentAccess>} */
  #input;
  #frames;
  #focus;
  constructor({ input, frames, focus }) {
    this.#input = input;
    this.#frames = frames;
    this.#focus = focus;
  }
  canResumeImage(job) {
    if (!object(job) || !hash(job.id)) return false;
    const saved = this.#input.current ?? this.#input.textResume;
    return (
      !this.#input.closed &&
      this.#input.imageSubmitAttempted !== job?.id &&
      saved?.jobId === job?.id &&
      saved.imageApplied === job?.id &&
      saved.account === job.account &&
      saved.target === job.target &&
      hash(job.image?.sha256) &&
      saved.imageSha256 === job.image.sha256 &&
      object(saved.binding) &&
      (this.#frames.config.layoutMode === 'uia-v1'
        ? validUiaImageProof(saved.uiaImageProof, job.image) &&
          validConversationFingerprint(saved.uiaConversationFingerprint)
        : hash(saved.header) && hash(saved.editor))
    );
  }
  acceptUiaImageFrame(frame, saved, { source = false } = {}) {
    this.#input.active();
    this.#frames.assertTransaction(frame);
    const roles = source ? ['header', 'editor'] : ['header', 'editor', 'send'],
      lease = this.#focus.preparationLease();
    if (
      this.#frames.config.layoutMode !== 'uia-v1' ||
      this.#frames.navigationPolicy !== 'uia-controls-v1' ||
      this.#input.controlVerificationPolicy !== 'input-boundaries-v1' ||
      !validConversationFingerprint(saved.uiaConversationFingerprint) ||
      !saved.shared ||
      saved.draftPolicy !== 'unchecked' ||
      !lease ||
      lease.owner !== this.#input.nativeOwner ||
      lease.parked ||
      frame.observationKind !== 'uia-metadata-v1' ||
      frame.pixelsRead !== false ||
      frame.uiaControlFrame !== true ||
      frame.navigationOnly === true ||
      frame.popup ||
      frame.pixelFormat !== undefined ||
      frame.regions.length !== roles.length ||
      !roles.every(
        (role, index) =>
          frame.regions[index].role === role &&
          hash(frame.regions[index].controlSha256) &&
          frame.regions[index].rgbaSha256 === undefined &&
          sameRect(frame.regions[index].rect, this.#frames.config.layout[role]),
      ) ||
      frame.epoch !== saved.epoch ||
      frame.revision !== saved.revision ||
      !['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi'].every(
        key => frame.binding[key] === saved.binding?.[key],
      ) ||
      !['clientRect', 'captureRect'].every(key => sameRect(frame.binding[key], saved.binding?.[key]))
    )
      throw fault('UI_QT_CONTROLS_BINDING_CHANGED');
    return frame;
  }
  acceptPastedImageGeometry(frame, current) {
    const b = frame?.binding,
      roles = frame?.regions;
    if (
      !Array.isArray(roles) ||
      roles.length !== 3 ||
      !['header', 'editor', 'send'].every((role, index) => roles[index]?.role === role && rect(roles[index].rect)) ||
      !sameRect(roles[0].rect, this.#frames.config.layout.header) ||
      frame.epoch !== current.epoch ||
      frame.revision !== current.revision ||
      !['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi'].every(
        key => b?.[key] === current.binding?.[key],
      ) ||
      !['clientRect', 'captureRect'].every(key => sameRect(b?.[key], current.binding?.[key]))
    )
      throw fault('UI_QT_IMAGE_BINDING_CHANGED');
    this.#frames.adoptLayout({
      ...this.#frames.config.layout,
      editor: structuredClone(roles[1].rect),
      send: structuredClone(roles[2].rect),
    });
  }
  async pasteUiaImage(job, guard, current) {
    let entered = false,
      applied = false;
    try {
      const frame = this.acceptUiaImageFrame(this.#frames.frame, current, { source: true }),
        lease = this.#focus.preparationLease();
      await this.#input.verifyControlBinding(job, frame, 'image-input', guard.signal);
      this.#input.active();
      if (
        this.#input.current !== current ||
        this.#frames.frame !== frame ||
        this.#focus.preparationLease() !== lease ||
        lease.parked
      )
        throw fault('UI_QT_CONTROLS_BINDING_CHANGED');
      if (guard.signal?.aborted || guard.canInput() !== true)
        return { performed: false, attempted: false, reason: 'UI_TARGET_NOT_ALLOWED' };
      const ordinaryFile = job.mode === 'file' && job.image.format === 'file';
      entered = true;
      const result = await this.#input.requestNative(ordinaryFile ? 'pasteUiaFile' : 'pasteUiaImage', {
        allowClipboardReplacement: this.#input.allowClipboardReplacement,
        ...(ordinaryFile ? { deliveryId: job.id, titleSha256: current.privateChatProof?.titleSha256 } : {}),
        token: frame.token,
        epoch: frame.epoch,
        revision: frame.revision,
        idleMs: this.#frames.config.idleMs,
        headerRect: this.#frames.config.layout.header,
        editorRect: this.#frames.config.layout.editor,
        sendRect: this.#frames.config.layout.send,
        imagePath: job.image.path,
        imageSha256: job.image.sha256,
      });
      if (
        result?.performed !== true ||
        result.attempted !== true ||
        result.pasteApplied !== true ||
        !clipboardSettled(result, this.#input.allowClipboardReplacement) ||
        result.revision !== current.revision
      )
        throw fault('UI_QT_IMAGE_PASTE_UNCONFIRMED');
      applied = true;
      if (
        ordinaryFile &&
        (result.originalFilePasted !== true ||
          result.imageConsumption?.format !== 15 ||
          result.imageConsumption?.consumerProcessMatched !== true)
      )
        throw fault('UI_QT_FILE_PASTE_UNCONFIRMED');
      if (ordinaryFile && result.fileDialogProof) {
        const proof = result.fileDialogProof;
        if (
          !object(proof) ||
          Object.keys(proof).length !== 2 ||
          !/^[a-f0-9]{32}$/.test(proof.id) ||
          proof.sha256 !== job.image.sha256
        )
          throw fault('UI_QT_FILE_DIALOG_PROOF_INVALID');
        this.#input.rememberImageDraft(current, {
          imageApplied: job.id,
          imageSha256: job.image.sha256,
          fileDialogProof: structuredClone(proof),
        });
        this.#frames.invalidateFrame();
        return { performed: true, attempted: true, imageApplied: true, ...clipboardOutcome(result) };
      }
      if (
        !validUiaImageProof(result.imagePasteProof, job.image) ||
        (job.image.format === 'gif' && (result.imageFormat !== 'gif' || result.originalFilePasted !== true))
      )
        throw fault('UI_QT_IMAGE_PASTE_UNCONFIRMED');
      this.acceptPastedImageGeometry(result.postPasteFrame, current);
      const after = this.acceptUiaImageFrame(result.postPasteFrame, current);
      this.#frames.rememberFrame(after);
      this.#input.rememberImageDraft(current, {
        imageApplied: job.id,
        imageSha256: job.image.sha256,
        ...(job.image.format === 'gif' ? { imageFormat: 'gif' } : {}),
        uiaImageProof: structuredClone(result.imagePasteProof),
        uiaImageFrame: after,
        binding: structuredClone(after.binding),
      });
      return {
        performed: true,
        attempted: true,
        imageApplied: true,
        ...clipboardOutcome(result),
        readbackPerformed: false,
      };
    } catch (error) {
      if (!applied && error?.controlsCleanupFailed) throw error;
      if (
        !applied &&
        (error.clipboardRestored !== false || clipboardSettled(error, this.#input.allowClipboardReplacement)) &&
        (!entered || error.attempted === false)
      )
        return { performed: false, attempted: false, reason: codeFor(error), ...clipboardFailureDiagnostic(error) };
      this.#input.holdDraft(job);
      error.attempted = true;
      throw error;
    }
  }
  async submitUiaImage(job, guard, current) {
    try {
      if (job.mode === 'file' && current.fileDialogProof) {
        if (guard.signal?.aborted || !guard.canSubmit()) return { performed: false, attempted: false };
        this.#input.beginImageSubmission(job);
        const result = await this.#input.requestNative('submitUiaFileDialog', {
          proofId: current.fileDialogProof.id,
          sha256: job.image.sha256,
        });
        if (
          result.performed !== true ||
          result.attempted !== true ||
          result.inputQueued !== true ||
          result.revision !== current.revision
        )
          throw fault('UI_QT_FILE_SUBMIT_UNCONFIRMED');
        this.#input.discardDraft();
        return { performed: true, attempted: true };
      }
      if (!validUiaImageProof(current.uiaImageProof, job.image) || this.#frames.frame !== current.uiaImageFrame)
        throw fault('UI_QT_IMAGE_APPLICATION_UNKNOWN');
      const frame = this.acceptUiaImageFrame(this.#frames.frame, current),
        lease = this.#focus.preparationLease(),
        proof = structuredClone(current.uiaImageProof);
      await this.#input.verifyControlBinding(job, frame, 'image-submit', guard.signal);
      this.#input.active();
      if (
        this.#input.current !== current ||
        this.#frames.frame !== frame ||
        this.#focus.preparationLease() !== lease ||
        !isDeepStrictEqual(current.uiaImageProof, proof)
      )
        throw fault('UI_QT_CONTROLS_BINDING_CHANGED');
      if (guard.signal?.aborted || guard.canSubmit() !== true)
        return { performed: false, attempted: false, reason: 'UI_TARGET_NOT_ALLOWED' };
      this.#input.beginImageSubmission(job);
      const result = await this.#input.requestNative('submitUiaImage', {
        token: frame.token,
        epoch: frame.epoch,
        revision: frame.revision,
        idleMs: this.#frames.config.idleMs,
        imagePasteProofId: proof.id,
        imageSha256: proof.imageSha256,
      });
      const queued =
        result?.inputQueued === true &&
        result.submitted === false &&
        result.submissionConfirmed === false &&
        validUiaPointerDelivery(result.pointerDelivery, 'image-submit');
      if (result?.performed !== true || result.attempted !== true || !queued || result.revision !== current.revision)
        throw fault('UI_QT_IMAGE_SUBMIT_UNCONFIRMED');
      this.#input.discardDraft();
      return { performed: true, attempted: true };
    } finally {
      await this.#focus.releaseTextFocus();
    }
  }
  async resumeImage(job, { signal, canInput } = {}) {
    this.#input.checkJob(job);
    if (this.#input.busy) throw fault('UI_QT_BUSY');
    if (!this.canResumeImage(job)) return { ready: false, reason: 'UI_QT_IMAGE_RESUME_UNAVAILABLE' };
    if (typeof canInput !== 'function' || canInput() !== true) return { ready: false, reason: 'UI_TARGET_NOT_ALLOWED' };
    const saved = this.#input.current ?? this.#input.textResume,
      owner = this.#input.nativeOwner,
      ownedImageFrame =
        this.#input.current === saved && this.#focus.textFocusLease && this.#frames.frame === saved.uiaImageFrame
          ? this.#frames.frame
          : null;
    let resumed = false;
    const finishOperation = this.#input.beginOperation(signal);
    this.#input.invalidateNavigation();
    const matches = binding =>
      object(binding) &&
      ['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi'].every(
        key => binding[key] === saved.binding[key],
      ) &&
      ['clientRect', 'captureRect'].every(key => sameRect(binding[key], saved.binding[key]));
    try {
      this.#input.active();
      if (this.#focus.textFocusRelease) await this.#focus.textFocusRelease;
      const inspection = await this.#input.requestNative('inspectLayout', undefined, owner);
      this.#input.active();
      if (
        inspection?.readOnly !== true ||
        inspection.inputSent !== false ||
        inspection.focusChanged !== false ||
        inspection.clipboardAccessed !== false ||
        inspection.executableVersion !== this.#frames.config.executableVersion ||
        inspection.executableSha256 !== this.#frames.config.executableSha256 ||
        !matches(inspection.binding)
      )
        throw fault('UI_QT_IMAGE_RESUME_BINDING_CHANGED');
      const account = await this.#input.freshAccount({ frame: { binding: inspection.binding }, park: false });
      this.#input.active();
      validateAccountEvidence(account.evidence, inspection.binding, this.#input.now());
      if (canInput() !== true) return { ready: false, reason: 'UI_TARGET_NOT_ALLOWED' };
      if (saved.shared && !this.#focus.textFocusLease) {
        const preflight = await this.#focus.inspectFocusHandoff(owner);
        if (!preflight.ready && preflight.reason !== 'QT_FOCUS_RETURN_WINDOW_REQUIRED')
          return { ready: false, reason: preflight.reason };
        const inPlace =
          preflight.reason === 'QT_FOCUS_RETURN_WINDOW_REQUIRED' && this.#frames.config.layoutMode === 'uia-v1';
        if (preflight.ready || inPlace) {
          if (canInput() !== true) return { ready: false, reason: 'UI_TARGET_NOT_ALLOWED' };
          const acquired = await this.#input.requestNative(
            inPlace ? 'beginForegroundSession' : 'beginFocusHandoff',
            {
              idleMs: this.#frames.config.idleMs,
              width: this.#frames.config.layout.width,
              height: this.#frames.config.layout.height,
              dpi: this.#frames.config.layout.dpi,
              ...(inPlace ? { uiaMode: true } : { includesContactNavigation: false, ...this.#focus.focusActivation() }),
            },
            owner,
          );
          if (
            inPlace
              ? !validForegroundSession(acquired)
              : acquired?.activated !== true || !validFocusHandoff(acquired.focusHandoff)
          )
            throw fault('UI_QT_FOCUS_LEASE_INVALID');
          this.#focus.beginTextLease(owner, acquired, { inPlace });
        }
      }
      this.#input.resetInputSession('main');
      if (this.#frames.config.layoutMode === 'uia-v1') {
        let frame = ownedImageFrame,
          proof = saved.uiaImageProof;
        if (!frame) {
          const result = await this.#input.requestNative(
            'resumeUiaImage',
            {
              epoch: saved.epoch,
              revision: saved.revision,
              idleMs: this.#frames.config.idleMs,
              imagePasteProofId: proof.id,
              imageSha256: proof.imageSha256,
            },
            owner,
          );
          this.#input.active();
          if (
            result?.resumed !== true ||
            result.readOnly !== true ||
            result.inputSent !== false ||
            result.focusChanged !== false ||
            result.clipboardAccessed !== false ||
            !validUiaImageProof(result.imagePasteProof, job.image) ||
            !isDeepStrictEqual(result.imagePasteProof, proof)
          )
            throw fault('UI_QT_IMAGE_RESUME_BINDING_CHANGED');
          frame = result.frame;
        }
        this.acceptUiaImageFrame(frame, saved);
        this.#frames.rememberFrame(frame);
        this.#frames.bindInputTransaction(frame);
        const verified = await this.#input.verifyControlBinding(job, frame, 'image-resume', signal);
        if (
          !validConversationFingerprint(verified?.conversationFingerprint) ||
          !isDeepStrictEqual(verified.conversationFingerprint, saved.uiaConversationFingerprint)
        )
          throw fault('UI_QT_IMAGE_DRAFT_CHANGED');
        validateAccountEvidence(account.evidence, frame.binding, this.#input.now());
        this.#input.active();
        if (canInput() !== true) return { ready: false, reason: 'UI_TARGET_NOT_ALLOWED' };
        this.#input.rememberResumedImage(saved, {
          uiaImageFrame: frame,
          uiaImageProof: structuredClone(proof),
          binding: structuredClone(frame.binding),
        });
        resumed = true;
        return { ready: true, imageResume: true };
      }
      const frame = await this.#frames.capture(['header', saved.imageFormat === 'gif' ? 'send' : 'editor']);
      if (!matches(frame.binding) || frame.epoch !== saved.epoch) throw fault('UI_QT_IMAGE_RESUME_BINDING_CHANGED');
      // GIF pixels change without user input. Its same-process paste proof can
      // survive a queue pause, but not intervening human input or a new epoch.
      if (saved.imageFormat === 'gif' && frame.revision !== saved.revision) throw fault('UI_QT_IMAGE_DRAFT_CHANGED');
      if (
        frame.popup ||
        frame.regions.length !== 2 ||
        frame.regions[0].rgbaSha256 !== saved.header ||
        frame.regions[1].rgbaSha256 !== saved.editor
      )
        throw fault('UI_QT_IMAGE_DRAFT_CHANGED');
      if (frame.idleMs < this.#frames.config.idleMs) throw fault('UI_USER_ACTIVE');
      validateAccountEvidence(account.evidence, frame.binding, this.#input.now());
      this.#input.active();
      if (canInput() !== true) return { ready: false, reason: 'UI_TARGET_NOT_ALLOWED' };
      this.#frames.bindInputTransaction(frame);
      this.#input.rememberResumedImage(saved, {
        epoch: frame.epoch,
        revision: frame.revision,
        binding: structuredClone(frame.binding),
      });
      resumed = true;
      return { ready: true, imageResume: true };
    } catch (error) {
      if (['UI_QT_IMAGE_RESUME_BINDING_CHANGED', 'UI_QT_IMAGE_DRAFT_CHANGED', 'UI_USER_ACTIVE'].includes(error.code))
        return { ready: false, reason: error.code };
      throw error;
    } finally {
      try {
        if (!resumed) {
          await this.#focus.releaseTextFocus();
          this.#input.resetInputSession();
          this.#input.rememberPausedImage(saved, owner);
        }
      } finally {
        finishOperation();
      }
    }
  }
  async pasteImage(job, guard, local = {}) {
    guard = { ...guard, ...(typeof local.canInput === 'function' ? { canInput: local.canInput } : {}) };
    this.#input.checkJob(job);
    const current = this.#input.current;
    if (
      !current ||
      current.jobId !== job.id ||
      current.account !== job.account ||
      current.target !== job.target ||
      guard?.editorToken !== current.editorToken ||
      guard.activityRevision !== current.revision ||
      typeof guard.canInput !== 'function' ||
      guard.canInput() !== true
    )
      return { performed: false, attempted: false, reason: 'UI_QT_INPUT_AUTHORIZATION_REQUIRED' };
    if (current.imageApplied || !object(job.image) || !hash(job.image.sha256) || !path.isAbsolute(job.image.path ?? ''))
      return { performed: false, attempted: false, reason: 'UI_QT_IMAGE_INVALID' };
    if (this.#frames.config.layoutMode === 'uia-v1') return this.pasteUiaImage(job, guard, current);
    let entered = false,
      pasteApplied = false;
    try {
      const frame = await this.#frames.capture(['header', 'editor']);
      if (frame.regions[0].rgbaSha256 !== current.header)
        return { performed: false, attempted: false, reason: 'UI_QT_HEADER_CHANGED' };
      await this.#input.verifyControlBinding(job, frame, 'image-input', guard.signal);
      this.#input.active();
      if (guard.signal?.aborted || guard.canInput() !== true)
        return { performed: false, attempted: false, reason: 'UI_TARGET_NOT_ALLOWED' };
      entered = true;
      const result = await this.#input.requestNative(job.mode === 'file' ? 'pasteFile' : 'pasteImage', {
        ...(job.mode === 'file' ? { deliveryId: job.id } : {}),
        sendRect: this.#frames.config.layout.send,
        allowClipboardReplacement: this.#input.allowClipboardReplacement,
        token: frame.token,
        epoch: frame.epoch,
        revision: frame.revision,
        idleMs: this.#frames.config.idleMs,
        headerRect: this.#frames.config.layout.header,
        editorRect: this.#frames.config.layout.editor,
        foregroundOnly: !this.#focus.preparationLease(),
        imagePath: job.image.path,
        imageSha256: job.image.sha256,
      });
      if (
        result.performed !== true ||
        result.attempted !== true ||
        result.pasteApplied !== true ||
        !clipboardSettled(result, this.#input.allowClipboardReplacement) ||
        result.revision !== current.revision
      )
        throw fault('UI_QT_IMAGE_PASTE_UNCONFIRMED');
      pasteApplied = true;
      const gif = job.image.format === 'gif',
        ordinaryFile = job.mode === 'file';
      if (
        ordinaryFile &&
        (result.imageFormat !== 'file' ||
          result.originalFilePasted !== true ||
          result.imageConsumption?.consumerProcessMatched !== true)
      )
        throw fault('UI_QT_FILE_PASTE_UNCONFIRMED');
      if (gif && (result.imageFormat !== 'gif' || result.originalFilePasted !== true))
        throw fault('UI_QT_IMAGE_PASTE_UNCONFIRMED');
      // The animation is intentionally excluded from stable pixel anchors.
      // Native input still binds the account/window, header and activity epoch.
      this.#frames.invalidateFrame();
      const after = await this.#frames.capture(['header', gif || ordinaryFile ? 'send' : 'editor']);
      if (after.regions[0].rgbaSha256 !== current.header) throw fault('UI_QT_HEADER_CHANGED');
      this.#input.rememberImageDraft(current, {
        imageApplied: job.id,
        imageSha256: job.image.sha256,
        ...(gif || ordinaryFile ? { imageFormat: ordinaryFile ? 'file' : 'gif' } : {}),
        binding: structuredClone(after.binding),
        header: after.regions[0].rgbaSha256,
        editor: after.regions[1].rgbaSha256,
      });
      return {
        performed: true,
        attempted: true,
        imageApplied: true,
        ...clipboardOutcome(result),
        readbackPerformed: false,
      };
    } catch (error) {
      if (!pasteApplied && error?.controlsCleanupFailed) throw error;
      if (
        !pasteApplied &&
        (error.clipboardRestored !== false || clipboardSettled(error, this.#input.allowClipboardReplacement)) &&
        (!entered || error.attempted === false)
      )
        return { performed: false, attempted: false, reason: codeFor(error), ...clipboardFailureDiagnostic(error) };
      this.#input.holdDraft(job);
      if (pasteApplied) error.attempted = true;
      throw error;
    }
  }
  async submitImage(job, guard, local = {}) {
    guard = { ...guard, ...(typeof local.canSubmit === 'function' ? { canSubmit: local.canSubmit } : {}) };
    this.#input.checkJob(job);
    const current = this.#input.current;
    if (!this.#input.allowSubmit) return { performed: false, attempted: false, reason: 'UI_SUBMIT_DISABLED' };
    if (this.#input.imageSubmitAttempted === job.id)
      return { performed: false, attempted: false, reason: 'UI_QT_IMAGE_SUBMIT_UNCONFIRMED' };
    if (
      !current ||
      current.imageApplied !== job.id ||
      current.imageSha256 !== job.image?.sha256 ||
      current.editorToken !== guard?.editorToken ||
      current.revision !== guard.activityRevision ||
      typeof guard.canSubmit !== 'function' ||
      guard.canSubmit() !== true
    )
      return { performed: false, attempted: false, reason: 'UI_QT_IMAGE_APPLICATION_UNKNOWN' };
    if (this.#frames.config.layoutMode === 'uia-v1') return this.submitUiaImage(job, guard, current);
    try {
      const frame = await this.#frames.capture([
        'header',
        ['gif', 'file'].includes(current.imageFormat) ? 'send' : 'editor',
      ]);
      if (frame.regions[0].rgbaSha256 !== current.header)
        return { performed: false, attempted: false, reason: 'UI_QT_HEADER_CHANGED' };
      await this.#input.verifyControlBinding(job, frame, 'image-submit', guard.signal);
      this.#input.active();
      if (guard.signal?.aborted || guard.canSubmit() !== true)
        return { performed: false, attempted: false, reason: 'UI_TARGET_NOT_ALLOWED' };
      // Images are inline attachments on this client; click its current send
      // control. A changed focus never grants a second keyboard submission.
      this.#input.beginImageSubmission(job);
      const result = await this.#input.requestNative('submitOcrMedia', {
        token: frame.token,
        epoch: frame.epoch,
        revision: frame.revision,
        idleMs: this.#frames.config.idleMs,
        rect: this.#frames.config.layout.send,
      });
      if (result.performed !== true || result.attempted !== true) throw fault('UI_QT_IMAGE_SUBMIT_UNCONFIRMED');
      this.#input.discardDraft();
      return { performed: true, attempted: true };
    } finally {
      await this.#focus.releaseTextFocus();
    }
  }
}

export { QtAttachmentSession };
