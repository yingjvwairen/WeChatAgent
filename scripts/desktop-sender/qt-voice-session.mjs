import {
  fault,
  markNavigationRefusal,
  object,
  observedLayout,
  preparationWaits,
  preparedTargetLookup,
  qtEmptyEditorPhaseMatches,
  sharedVoicePreparation,
  transferredFocusValidation,
  validConversationFingerprint,
  validFocusHandoff,
  validVoiceLayout,
} from './qt-contract.mjs';
import { validateAccountEvidence } from './account-probe.mjs';
import crypto from 'node:crypto';
import { focusRestoreOutcomeDiagnostic, focusReturnDiagnostics } from './qt-diagnostics.mjs';

// Stateless operations over the driver's shared window and input session.
class QtVoiceSession {
  /** @type {ReturnType<typeof import('./qt-session-access.mjs').voiceAccess>} */
  #input;
  #frames;
  #focus;
  #cleanup;
  #lookupTarget;
  #warmLocators;
  constructor({ input, frames, focus, cleanup, lookupTarget, warmLocators }) {
    this.#input = input;
    this.#frames = frames;
    this.#focus = focus;
    this.#cleanup = cleanup;
    this.#lookupTarget = lookupTarget;
    this.#warmLocators = warmLocators;
  }
  async prepareVoiceHandoff(job, { signal } = {}) {
    this.#input.checkJob(job);
    if (this.#input.busy) return { ready: false, reason: 'UI_QT_BUSY' };
    if (signal?.aborted) return { ready: false, reason: 'UI_QT_CANCELLED' };
    if (
      !validVoiceLayout(
        this.#frames.config.voice,
        this.#frames.config.layout,
        this.#frames.config.layoutMode === 'uia-v1',
      )
    )
      return { ready: false, reason: 'UI_QT_VOICE_CALIBRATION_REQUIRED' };
    const finishOperation = this.#input.beginOperation(signal);
    try {
      const result = await this.#focus.inspectFocusHandoff();
      if (signal?.aborted) return { ready: false, reason: 'UI_QT_CANCELLED' };
      return result.ready ? { ready: true } : { ready: false, reason: result.reason };
    } catch (error) {
      // Native focus inspection does not borrow focus or begin a recording.
      error.attempted = false;
      throw error;
    } finally {
      finishOperation();
    }
  }
  async #sameEmptyDraft(job, emptyDraft, frame, { uiaVoice, unchecked }) {
    if (
      this.#input.current !== emptyDraft ||
      emptyDraft.draft !== '' ||
      emptyDraft.account !== job.account ||
      emptyDraft.target !== job.target ||
      frame.epoch !== emptyDraft.epoch ||
      frame.revision !== emptyDraft.revision
    )
      return false;
    if (uiaVoice)
      return (
        frame.observationKind === 'uia-metadata-v1' &&
        frame.pixelsRead === false &&
        this.#frames.regionDigest(frame, 0) === emptyDraft.header
      );
    if (frame.regions[0].rgbaSha256 !== emptyDraft.header) return false;
    if (unchecked) return true;
    const before = emptyDraft.editor,
      after = frame.regions[1].rgbaSha256,
      known = emptyDraft.verifiedEmptyHashes;
    if (after === before || qtEmptyEditorPhaseMatches(before, after, known)) return true;
    const proof = emptyDraft.emptyDraftPhaseProof,
      baselineVerified =
        known?.includes(before) ||
        (emptyDraft.verifiedEmptyPhase?.proofId === proof?.id &&
          emptyDraft.verifiedEmptyPhase?.actualRgbaSha256 === before);
    if (!proof || !baselineVerified) return false;
    if (known.includes(after)) return true;
    await this.#input.inspectEmptyDraftPhase(frame, proof);
    return this.#input.current === emptyDraft && emptyDraft.draft === '';
  }
  #recordingSession(job, voice, emptyDraft, frame, { uiaVoice, unchecked }) {
    const at = this.#input.now();
    const calibrationHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(this.#frames.config.layout))
      .digest('hex');
    return {
      version: 2,
      id: crypto.randomBytes(16).toString('hex'),
      calibrationHash,
      accountScopeHash: this.#frames.config.accountRef,
      target: job.target,
      executable: this.#frames.config.executable,
      hwnd: frame.binding.hwnd,
      focusHwnd: frame.binding.focusHwnd,
      processCreatedFileTimeUtc: frame.binding.processCreatedFileTimeUtc,
      pid: frame.binding.pid,
      dpi: frame.binding.dpi,
      lastInputTick: frame.binding.lastInputTick,
      clientRect: frame.binding.clientRect,
      captureRect: frame.binding.captureRect,
      editorRect: this.#frames.config.layout.editor,
      issuedAtMs: at,
      expiresAtMs: at + 30000,
      emptyDraftConfirmed: !unchecked,
      ...(unchecked ? { draftPolicy: 'unchecked' } : {}),
      recordStartRect: voice.recordStartRect,
      ...(voice.mouseParkRect !== undefined ? { mouseParkRect: voice.mouseParkRect } : {}),
      recordingUi: {
        ...voice.recordingUi,
        focusHwnd: voice.recordingUi.focusHwnd === 'same' ? frame.binding.focusHwnd : voice.recordingUi.focusHwnd,
        ...(uiaVoice
          ? {
              uia: {
                ...voice.recordingUi.uia,
                conversationFingerprint: structuredClone(emptyDraft.uiaConversationFingerprint),
              },
            }
          : {}),
      },
      targetProof: {
        kind: job.target.endsWith('@chatroom') ? 'verified-qt-group-chat-v1' : 'verified-qt-private-chat-v1',
        target: job.target,
        accountRef: this.#frames.config.accountRef,
        ...(job.target.endsWith('@chatroom') ? { querySha256: emptyDraft.privateChatProof.querySha256 } : {}),
        ...(uiaVoice
          ? { conversationFingerprint: structuredClone(emptyDraft.uiaConversationFingerprint) }
          : { titleAnchor: { rect: this.#frames.config.layout.header, rgbaSha256: frame.regions[0].rgbaSha256 } }),
      },
    };
  }
  async prepareVoiceSession(job, { signal, interactionPlan } = {}) {
    this.#input.checkJob(job);
    const voice = this.#frames.config.voice;
    if (!validVoiceLayout(voice, this.#frames.config.layout, this.#frames.config.layoutMode === 'uia-v1'))
      throw fault('UI_QT_VOICE_CALIBRATION_REQUIRED');
    const shared = interactionPlan?.executionMode === 'focus-handoff';
    let leaseOwner, transferred, releaseFocus, accountProof, finishOperation, transferOwner, transferValidation;
    const voicePreparation =
      shared && observedLayout(this.#frames.config) ? { controller: new AbortController() } : null;
    const abortProbe = () => voicePreparation?.controller.abort();
    if (voicePreparation) {
      signal?.addEventListener('abort', abortProbe, { once: true });
      if (signal?.aborted) abortProbe();
      // Start one read-only account scan after search Enter, alongside page
      // presentation. Keep its original timestamp and the existing 500ms limit.
      voicePreparation.start = frame => {
        if (!voicePreparation.pending) {
          const binding = structuredClone(frame.binding);
          voicePreparation.pending = Promise.resolve()
            .then(() =>
              this.#input.probeAccount({
                root: this.#input.root,
                binding,
                executable: this.#frames.config.executable,
                expectedAccountRef: this.#frames.config.accountRef,
                signal: voicePreparation.controller.signal,
              }),
            )
            .then(
              proof => ({ proof }),
              error => ({ error }),
            );
        }
      };
    }
    try {
      if (this.#input.busy || signal?.aborted) throw fault(signal?.aborted ? 'UI_QT_CANCELLED' : 'UI_QT_BUSY');
      const targetLookup =
        shared && observedLayout(this.#frames.config)
          ? await this.#lookupTarget(job, { signal })
          : (await Promise.all([this.#input.warmRecognition(signal), this.#lookupTarget(job, { signal })]))[1];
      if (shared) {
        if (this.#input.busy || signal?.aborted) throw fault(signal?.aborted ? 'UI_QT_CANCELLED' : 'UI_QT_BUSY');
        leaseOwner = this.#input.nativeOwner;
        await this.#warmLocators({ owner: leaseOwner, signal });
        const acquired = await this.#input.requestNative(
          'beginFocusHandoff',
          {
            idleMs: this.#frames.config.idleMs,
            width: this.#frames.config.layout.width,
            height: this.#frames.config.layout.height,
            dpi: this.#frames.config.layout.dpi,
            includesContactNavigation: observedLayout(this.#frames.config),
            ...this.#focus.focusActivation(),
          },
          leaseOwner,
        );
        if (acquired?.activated !== true || !validFocusHandoff(acquired.focusHandoff))
          throw fault('UI_QT_FOCUS_LEASE_INVALID');
        this.#focus.beginVoiceLease(leaseOwner, acquired.focusHandoff);
        if (voicePreparation) voicePreparation.lease = this.#focus.voiceFocusLease;
      }
      const preparation = await this.#input.prepare(job, {
        signal,
        textEntryMode: interactionPlan?.textEntryMode ?? 'humanized',
        [preparedTargetLookup]: targetLookup,
        ...(voicePreparation ? { [sharedVoicePreparation]: voicePreparation } : {}),
      });
      if (preparation?.ready !== true)
        throw fault(preparationWaits.has(preparation?.reason) ? preparation.reason : 'UI_QT_PREPARATION_REQUIRED', {
          attempted: false,
          waitable: true,
        });
      finishOperation = this.#input.beginOperation(signal);
      if (signal?.aborted) {
        await this.#cleanup.close();
        throw fault('UI_QT_CANCELLED');
      }
      if (!this.#input.current || this.#input.current.draft !== '') throw fault('UI_QT_EMPTY_DRAFT_REQUIRED');
      const emptyDraft = this.#input.current,
        unchecked = shared && this.#input.current.draftPolicy === 'unchecked';
      const uiaVoice =
        this.#frames.config.layoutMode === 'uia-v1' &&
        this.#frames.navigationPolicy === 'uia-controls-v1' &&
        this.#input.controlVerificationPolicy === 'input-boundaries-v1';
      if (
        uiaVoice &&
        (!unchecked ||
          !object(voice.recordingUi.uia) ||
          !validConversationFingerprint(emptyDraft.uiaConversationFingerprint))
      )
        throw fault('UI_QT_CONTROLS_UNVERIFIED');
      let frame = unchecked ? this.#frames.frame : await this.#frames.capture(['header', 'editor']);
      if (signal?.aborted) {
        await this.#cleanup.close();
        throw fault('UI_QT_CANCELLED');
      }
      if (!(await this.#sameEmptyDraft(job, emptyDraft, frame, { uiaVoice, unchecked })))
        throw fault('UI_QT_DRAFT_CHANGED');
      if (shared) {
        // The unchecked voice path retains its ready main frame. Native transfer
        // checks activity again; the legacy verified route still parks and
        // rechecks its empty-draft frame around the account probe.
        const probe = async () => {
          const proof = await this.#input.probeAccount({
            root: this.#input.root,
            binding: frame.binding,
            executable: this.#frames.config.executable,
            expectedAccountRef: this.#frames.config.accountRef,
            signal,
          });
          if (
            proof?.accountRef !== this.#frames.config.accountRef ||
            proof.evidence?.processOpenedExpectedDatabase !== true ||
            proof.evidence?.processId !== frame.binding.pid ||
            proof.evidence?.processCreatedFileTimeUtc !== frame.binding.processCreatedFileTimeUtc
          )
            throw fault('UI_QT_ACCOUNT_UNVERIFIED');
          return proof;
        };
        accountProof =
          voicePreparation?.proof ?? (unchecked ? await probe() : await this.#focus.withPreparationFocusParked(probe));
        // UIA scans can outlive the overlapping account proof. They retain the
        // initial validation above, then obtain a new proof after final release.
        if (voicePreparation && !this.#input.verifyControls)
          validateAccountEvidence(accountProof.evidence, frame.binding, this.#input.now());
        if (!unchecked) frame = await this.#frames.capture(['header', 'editor']);
        if (!(await this.#sameEmptyDraft(job, emptyDraft, frame, { uiaVoice, unchecked })))
          throw fault('UI_QT_DRAFT_CHANGED');
      }
      await this.#input.verifyControlBinding(job, frame, 'voice-start', signal);
      const session = this.#recordingSession(job, voice, emptyDraft, frame, { uiaVoice, unchecked });
      this.#cleanup.requireReleasable();
      if (shared) {
        transferOwner = this.#input.nativeOwner;
        const originalHandoff = structuredClone(this.#focus.voiceFocusLease?.handoff);
        transferred = await this.#input.requestNative('transferFocusHandoff');
        transferValidation = transferredFocusValidation(transferred, frame, originalHandoff, this.#input.now());
        if (transferred?.transferred === true) this.#focus.clearVoiceLease(transferOwner);
        if (transferValidation.cleanupAvailable) {
          releaseFocus = this.#cleanup.transferredFocusCleanup(transferOwner, transferred.cleanup);
        }
        if (!transferValidation.valid)
          throw fault('UI_QT_FOCUS_LEASE_INVALID', { focusTransferValidation: transferValidation });
        // Returning Qt's pointer is marked input and advances Windows' input
        // tick. Bind the unmonitored handoff gap to the guarded final tick.
        session.lastInputTick = transferred.cleanup.lastInputTick;
      }
      await this.#cleanup.releaseInput();
      // The old process has exited (and released the native mutex) before the
      // recording helper can start. A last-input tick binds the unmonitored gap.
      if (this.#input.verifyControls || !accountProof)
        accountProof = await this.#input.probeAccount({
          root: this.#input.root,
          binding: frame.binding,
          executable: this.#frames.config.executable,
          expectedAccountRef: this.#frames.config.accountRef,
          signal,
        });
      if (signal?.aborted) throw fault('UI_QT_CANCELLED');
      if (
        accountProof?.accountRef !== this.#frames.config.accountRef ||
        accountProof.evidence?.processId !== frame.binding.pid ||
        accountProof.evidence?.processCreatedFileTimeUtc !== frame.binding.processCreatedFileTimeUtc
      )
        throw fault('UI_QT_ACCOUNT_UNVERIFIED');
      if (this.#input.verifyControls) {
        if (accountProof.accountScopeHash !== this.#frames.config.accountRef) throw fault('UI_QT_ACCOUNT_UNVERIFIED');
        validateAccountEvidence(accountProof.evidence, frame.binding, this.#input.now());
      }
      const foregroundIntervals = shared ? this.#focus.completedForegroundIntervals() : undefined;
      return {
        session,
        accountProof,
        idleMs: this.#frames.config.idleMs,
        ...(shared
          ? {
              focusHandoff: structuredClone(transferred.focusHandoff),
              releaseFocus,
              ...(foregroundIntervals ? { foregroundIntervals } : {}),
            }
          : {}),
      };
    } catch (error) {
      abortProbe();
      if (releaseFocus) {
        try {
          const returned = await releaseFocus();
          if (returned?.restored !== true && returned?.skipped !== true) throw fault('UI_QT_FOCUS_RETURN_UNCONFIRMED');
          if (focusRestoreOutcomeDiagnostic(returned?.focusRestoreOutcome))
            error.focusRestoreOutcome = focusRestoreOutcomeDiagnostic(returned.focusRestoreOutcome);
        } catch (cleanupError) {
          throw fault('UI_QT_FOCUS_RETURN_UNCONFIRMED', {
            ...focusReturnDiagnostics(cleanupError),
            ...(transferValidation ? { focusTransferValidation: transferValidation } : {}),
          });
        }
      } else if (transferred?.transferred === true)
        throw fault('UI_QT_FOCUS_RETURN_UNCONFIRMED', { focusTransferValidation: transferValidation });
      else if (leaseOwner) {
        try {
          const returned = await this.#cleanup.releaseFocus(leaseOwner);
          if (returned?.restored === true && returned.skipped === false) markNavigationRefusal(error, 'restored');
        } catch {
          try {
            await this.#cleanup.close(leaseOwner);
          } catch {
            throw fault('UI_QT_FOCUS_RETURN_UNCONFIRMED');
          }
        }
      }
      throw error;
    } finally {
      abortProbe();
      await voicePreparation?.pending;
      signal?.removeEventListener('abort', abortProbe);
      this.#focus.clearVoiceLease(leaseOwner);
      finishOperation?.();
    }
  }
}

export { QtVoiceSession };
