import { QtEditorDraft } from './qt-editor-draft.mjs';
import { QtQuoteSession } from './qt-quote-session.mjs';
import { QtConversationPreparation } from './qt-conversation-preparation.mjs';
import { QtFocusSession } from './qt-focus-session.mjs';
import { QtWindowFrames } from './qt-window-frames.mjs';
import { QtNativeConnection } from './qt-native-connection.mjs';
import { navigationAccess, attachmentAccess, voiceAccess } from './qt-session-access.mjs';
import { textCommand, nativeTextProof } from './qt-text-command.mjs';
import { textDraftRequiresReview } from './text-contract.mjs';
import { desktopProcessIdentity, probeAccountBinding } from './account-probe.mjs';
import { recognizeImage, warmLocalOcr } from './visual-probe.mjs';
import path from 'node:path';
import {
  appliedPasteResult,
  clipboardSettled,
  codeFor,
  fault,
  hash,
  id,
  markNavigationRefusal,
  markUiaVerificationRefusal,
  noLinks,
  object,
  observedLayout,
  positiveDecimal,
  preparationWaits,
  preparedTargetLookup,
  sameRect,
  sharedTargetProof,
  sharedVoicePreparation,
  uiaEditorFocusReused,
  uiaVerificationRefusal,
  validConversationFingerprint,
  validUiaImageProof,
  validUiaPointerDelivery,
  validateQtConfig,
} from './qt-contract.mjs';
import { QtActionsClient } from './qt-actions-client.mjs';
import { isDeepStrictEqual } from 'node:util';
import { clipboardFailureDiagnostic } from './qt-diagnostics.mjs';
import { QtNavigationSession } from './qt-navigation-session.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { QtAttachmentSession } from './qt-attachment-session.mjs';
import { QtVoiceSession } from './qt-voice-session.mjs';
class QtVisualDriver {
  #quotes;
  #editor;
  #conversation;
  #navigation;
  #attachments;
  #voice;
  #current;
  get current() {
    return this.#current;
  }
  get transaction() {
    return this.#frames.transaction;
  }
  #busy;
  get busy() {
    return this.#busy;
  }
  #operationSignal;
  get operationSignal() {
    return this.#operationSignal;
  }
  get voiceFocusLease() {
    return this.#focus.voiceFocusLease;
  }
  get textFocusLease() {
    return this.#focus.textFocusLease;
  }
  get textFocusRelease() {
    return this.#focus.textFocusRelease;
  }
  #textResume;
  get textResume() {
    return this.#textResume;
  }
  #draftHold;
  get draftHold() {
    return this.#draftHold;
  }
  #imageSubmitAttempted;
  get imageSubmitAttempted() {
    return this.#imageSubmitAttempted;
  }
  #native;
  get nativeOwner() {
    return this.#native.owner;
  }
  get nativeRunning() {
    return this.#native.running;
  }
  resolveLayoutWith(resolve, options) {
    return this.#native.resolveLayout(resolve, options);
  }
  requestNative(action, values, owner) {
    return this.#native.request(action, values, owner);
  }
  get foregroundIntervals() {
    return this.#focus.foregroundIntervals;
  }
  get foregroundIntervalsInvalid() {
    return this.#focus.foregroundIntervalsInvalid;
  }
  // Only this owner changes the input session. Media operations receive read-only
  // observations and use these transitions to retain draft and focus invariants.
  beginOperation(signal) {
    if (this.#busy) throw fault('UI_QT_BUSY');
    this.#busy = true;
    this.#operationSignal = signal;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.#operationSignal = null;
      this.#busy = false;
    };
  }
  discardDraft() {
    this.#current = null;
    this.#frames.invalidateFrame();
  }
  resetInputSession(surface = this.surface) {
    this.discardDraft();
    this.#frames.clearTransaction();
    this.#frames.invalidateFrame(surface);
  }
  holdDraft(job) {
    this.#draftHold = { account: job.account, target: job.target };
    this.discardDraft();
  }
  rememberImageDraft(previous, update) {
    if (this.#current !== previous) throw fault('UI_QT_DRAFT_CHANGED');
    this.#current = { ...previous, ...update, editorToken: crypto.randomUUID(), verifiedAt: this.now() };
  }
  rememberResumedImage(previous, update) {
    this.#current = { ...previous, ...update, editorToken: crypto.randomUUID(), verifiedAt: this.now() };
    this.#textResume = null;
  }
  rememberPausedImage(previous, owner) {
    if (!this.closed && this.nativeOwner === owner) this.#textResume = previous;
  }
  beginImageSubmission(job) {
    if (this.#current?.jobId !== job.id) throw fault('UI_QT_IMAGE_APPLICATION_UNKNOWN');
    this.#imageSubmitAttempted = job.id;
  }
  refuseImageSubmission(job) {
    if (this.#imageSubmitAttempted !== job.id) throw fault('UI_QT_IMAGE_APPLICATION_UNKNOWN');
    this.#imageSubmitAttempted = null;
  }
  async #releaseClientForVoice() {
    await this.#native.releaseForVoice();
    this.resetInputSession();
    this.#native.renew();
  }

  #focus;
  #frames;
  get config() {
    return this.#frames.config;
  }
  #completedTextNavigation = null;
  get frame() {
    return this.#frames.frame;
  }
  get surface() {
    return this.#frames.surface;
  }
  get navigation() {
    return this.#navigation;
  }
  invalidateNavigation() {
    this.#completedTextNavigation = null;
  }
  constructor({
    root,
    config,
    client,
    clientFactory,
    allowSubmit = false,
    allowClipboardReplacement = false,
    receipt,
    resolveTarget,
    verifyControls,
    controlVerificationPolicy = 'all-operations',
    navigationPolicy = 'pixels-v1',
    probeAccount = probeAccountBinding,
    recognize = recognizeImage,
    warmOcr = recognize === recognizeImage ? warmLocalOcr : async () => {},
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
    now = Date.now,
  }) {
    this.root = path.resolve(root);
    this.#frames = new QtWindowFrames({
      config,
      navigationPolicy,
      request: (...args) => this.requestNative(...args),
      active: () => this.active(),
      wait: ms => this.wait(ms),
      hasForegroundLease: () => {
        const lease = this.#focus.preparationLease();
        return !!lease && !lease.parked;
      },
    });
    if (
      !client ||
      typeof client.request !== 'function' ||
      typeof allowSubmit !== 'boolean' ||
      typeof allowClipboardReplacement !== 'boolean' ||
      (allowSubmit && typeof receipt !== 'function')
    )
      throw fault('UI_QT_DRIVER_OPTIONS_INVALID');
    if (typeof warmOcr !== 'function') throw fault('UI_QT_DRIVER_OPTIONS_INVALID');
    if (verifyControls !== undefined && typeof verifyControls !== 'function')
      throw fault('UI_QT_DRIVER_OPTIONS_INVALID');
    if (
      !['all-operations', 'input-boundaries-v1'].includes(controlVerificationPolicy) ||
      (controlVerificationPolicy === 'input-boundaries-v1' && typeof verifyControls !== 'function')
    )
      throw fault('UI_QT_CONTROLS_POLICY_INVALID');
    this.controlVerificationPolicy = controlVerificationPolicy;
    if (
      !['pixels-v1', 'uia-controls-v1'].includes(navigationPolicy) ||
      (navigationPolicy === 'uia-controls-v1' && typeof verifyControls !== 'function')
    )
      throw fault('UI_QT_DRIVER_OPTIONS_INVALID');
    if (
      this.config.layoutMode === 'uia-v1' &&
      (navigationPolicy !== 'uia-controls-v1' || controlVerificationPolicy !== 'input-boundaries-v1')
    )
      throw fault('UI_QT_CONTROLS_POLICY_INVALID');
    this.allowSubmit = allowSubmit;
    this.allowClipboardReplacement = allowClipboardReplacement;
    this.receiptProvider = receipt;
    this.probeAccount = probeAccount;
    this.verifyControls = verifyControls;
    this.recognize = recognize;
    this.warmOcr = warmOcr;
    this.wait = wait;
    this.now = now;
    this.#native = new QtNativeConnection(
      client,
      clientFactory ??
        (() =>
          new QtActionsClient({
            root: this.root,
            config: this.config,
            enableInput: client.enableInput === true,
          })),
      () => this.active(),
    );
    if (typeof resolveTarget !== 'function') throw fault('DESKTOP_TARGET_RESOLVER_REQUIRED');
    this.resolveTarget = resolveTarget;
    this.#current = null;
    this.#frames.clearTransaction();
    this.#busy = false;
    this.closed = false;
    this.#draftHold = null;
    this.#focus = new QtFocusSession({
      root: this.root,
      native: this.#native,
      frames: this.#frames,
      active: () => this.active(),
      wait: ms => this.wait(ms),
      onTextRelease: () => {
        this.#textResume = this.#current;
        this.#current = null;
      },
      invalidateNavigation: () => this.invalidateNavigation(),
    });
    this.#editor = new QtEditorDraft(this.#frames, this.#focus, this);
    this.#navigation = new QtNavigationSession({
      input: navigationAccess(this),
      frames: this.#frames,
      focus: this.#focus,
    });
    this.#quotes = new QtQuoteSession({
      root: this.root,
      frames: this.#frames,
      active: () => this.active(),
      requestNative: (...args) => this.requestNative(...args),
      hasFocus: () => !!this.#focus.preparationLease(),
      textStepBinding: job => this.textStepBinding(job),
      verifyControlBinding: (...args) => this.verifyControlBinding(...args),
      recognize: this.recognize,
      wait: this.wait,
      discardNativeFrameImage: frame => this.discardNativeFrameImage(frame),
    });
    this.#conversation = new QtConversationPreparation(this.#frames, this.#navigation, this.#focus, {
      active: () => this.active(),
      now: this.now,
      verifyControls: !!verifyControls,
      freshAccount: options => this.freshAccount(options),
      verifyControlBinding: (...args) => this.verifyControlBinding(...args),
      resetInputSession: surface => this.resetInputSession(surface),
      resumableTextStep: (previous, job) => this.resumableTextStep(previous, job),
      resumeTextStep: (previous, job, frame) => this.resumeTextStep(previous, job, frame),
      sharedAction: (...args) => this.sharedAction(...args),
    });
    this.#attachments = new QtAttachmentSession({
      input: attachmentAccess(this),
      frames: this.#frames,
      focus: this.#focus,
    });
    this.#voice = new QtVoiceSession({
      input: voiceAccess(this),
      frames: this.#frames,
      focus: this.#focus,
      lookupTarget: (...args) => this.#navigation.lookupTarget(...args),
      warmLocators: options => this.#navigation.warmUiaLocators(options),
      cleanup: {
        requireReleasable: () => this.#native.requireReleasable(),
        releaseInput: () => this.#releaseClientForVoice(),
        close: owner => this.#native.close(owner),
        releaseFocus: owner => this.#native.releaseFocus(owner, true),
        transferredFocusCleanup: (owner, cleanup) => this.#native.transferredFocusCleanup(owner, cleanup),
      },
    });
  }
  withPreparationFocusParked(...args) {
    return this.#focus.withPreparationFocusParked(...args);
  }
  preparationLease() {
    return this.#focus.preparationLease();
  }
  releaseTextFocus() {
    return this.#focus.releaseTextFocus();
  }
  checkJob(job) {
    if (
      this.closed ||
      !object(job) ||
      job.account !== this.config.account ||
      !id(job.target) ||
      job.target === job.account
    )
      throw fault('UI_QT_PRIVATE_TARGET_REQUIRED');
  }
  active() {
    if (this.closed) throw fault('UI_QT_CLOSED');
    if (this.#operationSignal?.aborted) throw fault('UI_QT_CANCELLED');
  }
  async verifyControlBinding(
    job,
    frame,
    operation,
    signal = this.#operationSignal,
    { navigationReadiness, allowLayoutRefresh = false } = {},
  ) {
    if (!this.verifyControls) return;
    const config = structuredClone(this.config),
      binding = structuredClone(frame?.binding),
      transaction = structuredClone(this.#frames.transaction);
    const identity = {
      id: job.id,
      account: job.account,
      target: job.target,
      ...(job.mode
        ? {
            mode: job.mode,
          }
        : {}),
    };
    try {
      this.active();
      if (signal?.aborted) throw fault('UI_QT_CANCELLED');
      this.#frames.assertTransaction(frame);
      // The real UIA provider already resolved roles before navigation. This
      // explicit policy defers its next fresh check to actual input; it does
      // not supply a cached or fabricated verification result.
      if (operation === 'prepare' && this.controlVerificationPolicy === 'input-boundaries-v1') return;
      if (
        allowLayoutRefresh &&
        (operation !== 'navigation-ready' ||
          this.config.layoutMode !== 'uia-v1' ||
          !positiveDecimal(navigationReadiness?.searchPopupHwnd))
      )
        throw fault('UI_QT_CONTROLS_UNVERIFIED');
      const result = await this.verifyControls({
        root: this.root,
        config: structuredClone(config),
        job: structuredClone(identity),
        binding: structuredClone(binding),
        signal,
        operation,
        ...(navigationReadiness
          ? {
              navigationReadiness: structuredClone(navigationReadiness),
            }
          : {}),
        ...(allowLayoutRefresh
          ? {
              allowLayoutRefresh: true,
            }
          : {}),
      });
      this.active();
      if (signal?.aborted) throw fault('UI_QT_CANCELLED');
      if (result?.verified !== true || result.proof !== 'uia-controls-v1') throw fault('UI_QT_CONTROLS_UNVERIFIED');
      if (result.conversationFingerprint !== undefined && !validConversationFingerprint(result.conversationFingerprint))
        throw fault('UI_QT_CONTROLS_UNVERIFIED');
      if (
        !isDeepStrictEqual(this.config, config) ||
        !isDeepStrictEqual(frame.binding, binding) ||
        !isDeepStrictEqual(this.#frames.transaction, transaction) ||
        job.id !== identity.id ||
        job.account !== identity.account ||
        job.target !== identity.target
      )
        throw fault('UI_QT_CONTROLS_BINDING_CHANGED');
      this.#frames.assertTransaction(frame);
      if (this.#current?.jobId === job.id) {
        if (
          this.#current.uiaConversationFingerprint &&
          (!validConversationFingerprint(result.conversationFingerprint) ||
            !isDeepStrictEqual(this.#current.uiaConversationFingerprint, result.conversationFingerprint))
        )
          throw fault('UI_QT_HEADER_CHANGED');
        if (result.conversationFingerprint)
          this.#current.uiaConversationFingerprint = structuredClone(result.conversationFingerprint);
      }
      return result;
    } catch (error) {
      // Read-only verification precedes the next native input. Keep any owned
      // draft checkpoint, but return borrowed text/image focus on refusal.
      // Voice preparation owns a separate lease and releases it in its catch.
      const hadTextLease = !!this.#focus.textFocusLease,
        hadVoiceLease = !!this.#focus.voiceFocusLease;
      let returned;
      try {
        returned = await this.#focus.releaseTextFocus();
      } catch (cleanup) {
        cleanup.controlsCleanupFailed = true;
        throw cleanup;
      }
      const wrapped = fault(
        /^(?:UI_QT|UIA_MODE)_[A-Z0-9_]{1,70}$/.test(error?.code ?? '') ? error.code : 'UI_QT_CONTROLS_UNVERIFIED',
        {
          attempted: false,
          ...(/^UI_CONTROLS_[A-Z0-9_]{1,70}$/.test(error?.nativeReason ?? '')
            ? {
                nativeReason: error.nativeReason,
              }
            : {}),
          ...(error?.code === 'UIA_MODE_VERIFIER_CLEANUP_UNCONFIRMED'
            ? {
                controlsCleanupFailed: true,
              }
            : {}),
        },
      );
      throw markUiaVerificationRefusal(wrapped, operation, {
        hadTextLease,
        hadVoiceLease,
        returned,
      });
    }
  }
  async warmRecognition(signal) {
    if (this.closed || signal?.aborted) throw fault(this.closed ? 'UI_QT_CLOSED' : 'UI_QT_CANCELLED');
    if (this.config.ocrBackend === 'rapidocr')
      await Promise.all(
        ['small', 'medium'].map(model =>
          this.warmOcr({
            model,
            signal,
          }),
        ),
      );
    if (this.closed || signal?.aborted) throw fault(this.closed ? 'UI_QT_CLOSED' : 'UI_QT_CANCELLED');
  }
  async action(
    action,
    values = {},
    anchorNames = ['header'],
    { stabilizeSelfOpen = false, settleSearchQuery = false } = {},
  ) {
    if (
      stabilizeSelfOpen &&
      (action !== 'click' ||
        this.surface !== 'main' ||
        !sameRect(values.rect, this.config.layout.selfOpen) ||
        anchorNames.length !== 2 ||
        anchorNames[0] !== 'header' ||
        anchorNames[1] !== 'selfOpen')
    )
      throw fault('UI_QT_OBSERVATION_INVALID');
    if (
      settleSearchQuery &&
      (stabilizeSelfOpen ||
        action !== 'click' ||
        this.surface !== 'search' ||
        !observedLayout(this.config) ||
        !this.#focus.preparationLease() ||
        this.#focus.preparationLease().parked ||
        !sameRect(values.rect, this.config.layout.search) ||
        anchorNames.length !== 1 ||
        anchorNames[0] !== 'search')
    )
      throw fault('UI_QT_OBSERVATION_INVALID');
    const frame = stabilizeSelfOpen
      ? await this.navigation.stableSelfOpenFrame()
      : await this.#frames.capture(anchorNames);
    this.active();
    const result = await this.requestNative(action, {
      ...values,
      ...(action === 'paste'
        ? {
            allowClipboardReplacement: this.allowClipboardReplacement,
          }
        : {}),
      token: frame.token,
      epoch: frame.epoch,
      revision: frame.revision,
      idleMs: this.config.idleMs,
    });
    this.#frames.invalidateFrame();
    if (result.revision !== this.#frames.transaction.revision) throw fault('UI_QT_HUMAN_ACTIVITY_CHANGED');
    if (settleSearchQuery) {
      if (result.performed !== true || result.attempted !== true) throw fault('UI_QT_INPUT_UNVERIFIED');
      await this.navigation.settleSearchQueryClick(frame);
      return result;
    }
    const pasteComplete =
      action === 'paste' &&
      result.performed === true &&
      result.attempted === true &&
      result.pasteVerified === true &&
      clipboardSettled(result, this.allowClipboardReplacement) &&
      result.draft === values.expectedText &&
      (values.replaceSearch !== true || result.searchReplaced === true);
    const pointerComplete =
      action === 'movePointer' &&
      result.performed === true &&
      result.attempted === true &&
      result.pointerParked === true &&
      result.focusPreserved === true;
    // These replies include actual completion, not only SendInput acceptance.
    // The next action still starts with a new native pixel/focus observation.
    // Popup open/close, click and chord replies have no such UI completion proof.
    const delay =
      pasteComplete || pointerComplete
        ? 0
        : action === 'type'
          ? 120
          : action === 'movePointer'
            ? 35
            : (this.config.settleMs ?? 400);
    if (delay > 0) await this.wait(delay);
    this.active();
    return result;
  }
  discardNativeFrameImage(frame) {
    const file = frame?.image?.file;
    if (
      typeof file !== 'string' ||
      path.dirname(file) !== path.join(this.root, 'state/ui-host/qt-frames') ||
      !/^qt-[a-f0-9]{32}\.png$/.test(path.basename(file)) ||
      !fs.existsSync(file)
    )
      return;
    noLinks(file);
    fs.unlinkSync(file);
  }
  async freshAccount({ frame, park = true } = {}) {
    frame ??= await this.#frames.capture(['header']);
    const inspect = () =>
      this.probeAccount({
        root: this.root,
        binding: frame.binding,
        executable: this.config.executable,
        expectedAccountRef: this.config.accountRef,
        signal: this.#operationSignal,
      });
    const result =
      park && this.#focus.preparationLease() && this.surface === 'main'
        ? await this.#focus.withPreparationFocusParked(inspect)
        : await inspect();
    if (
      result?.accountRef !== this.config.accountRef ||
      result.evidence?.processOpenedExpectedDatabase !== true ||
      result.evidence?.processId !== frame.binding.pid ||
      result.evidence?.processCreatedFileTimeUtc !== frame.binding.processCreatedFileTimeUtc
    )
      throw fault('UI_QT_ACCOUNT_UNVERIFIED');
    return result;
  }
  inspectEmptyDraftPhase(frame, proof) {
    return this.#editor.inspectEmptyDraftPhase(frame, proof);
  }
  async closePreparationPopupAfterFailure() {
    const surface = this.surface,
      lease = this.#focus.preparationLease(),
      calibration = this.#frames.popupCalibration(surface);
    if (
      this.closed ||
      this.#operationSignal?.aborted ||
      !this.#frames.transaction ||
      !['self', 'profile'].includes(surface) ||
      this.config[surface + 'CloseKey'] !== 'Escape' ||
      !calibration ||
      lease?.parked
    )
      return {
        attempted: false,
        closed: false,
      };
    const configured = this.config[surface + 'Surface'],
      names = observedLayout(this.config)
        ? []
        : [
            {
              left: 0,
              top: 0,
              right: configured.width,
              bottom: configured.height,
            },
          ];
    // Only the popup causally opened by this transaction can be dismissed.
    // Capture/guard failures never produce an Escape aimed at another window.
    const frame = await this.#frames.capture(names, false, {
      retryPixelChanges: false,
    });
    this.active();
    const result = await this.requestNative('chord', {
      key: 'Escape',
      token: frame.token,
      epoch: frame.epoch,
      revision: frame.revision,
      idleMs: this.config.idleMs,
    });
    this.#frames.invalidateFrame();
    if (result.revision !== this.#frames.transaction.revision) throw fault('UI_QT_HUMAN_ACTIVITY_CHANGED');
    this.#frames.invalidateFrame('main');
    await this.wait(this.config.settleMs ?? 400);
    this.active();
    await this.#frames.capture(['header'], false, {
      retryPixelChanges: false,
    });
    return {
      attempted: true,
      closed: true,
    };
  }
  appliedPaste(result, text) {
    return appliedPasteResult(result, text, this.#frames.transaction?.revision, this.allowClipboardReplacement);
  }
  appliedTypedText(result, text) {
    if (
      result?.performed !== true ||
      result.attempted !== true ||
      result.typeApplied !== true ||
      (result.readbackPerformed === true ? result.draft !== text : result.readbackPerformed !== false) ||
      result.intendedText !== text ||
      result.clipboardAccessed !== false ||
      typeof result.interrupted !== 'boolean' ||
      result.revision !== this.#frames.transaction.revision
    )
      throw fault('UI_QT_TYPED_TEXT_UNCONFIRMED');
    return result;
  }
  async sharedAction(action, values = {}, names = ['header'], frame) {
    frame ??= await this.#frames.capture(names);
    this.active();
    this.#frames.assertTransaction(frame);
    const result = await this.requestNative(action, {
      ...values,
      token: frame.token,
      epoch: frame.epoch,
      revision: frame.revision,
      idleMs: this.config.idleMs,
    });
    this.#frames.invalidateFrame();
    if (result.revision !== this.#frames.transaction.revision) throw fault('UI_QT_HUMAN_ACTIVITY_CHANGED');
    const editor =
      this.config.layoutMode === 'uia-v1' &&
      this.#frames.navigationPolicy === 'uia-controls-v1' &&
      action === 'focusUiaEditor';
    if (
      result.performed !== true ||
      (result.attempted !== true && !(editor && uiaEditorFocusReused(result))) ||
      (editor && result.pointerDelivery != null && !validUiaPointerDelivery(result.pointerDelivery, 'editor-focus'))
    )
      throw fault('UI_QT_INPUT_UNVERIFIED');
    return result;
  }
  textStepBinding(job) {
    this.checkJob(job);
    if (!hash(job.id)) throw fault('UI_QT_TEXT_STEP_BINDING_INVALID');
    const digest = value => crypto.createHash('sha256').update(value).digest('hex');
    return {
      version: 1,
      deliveryId: job.id,
      accountSha256: digest(job.account),
      targetSha256: digest(job.target),
    };
  }
  resumableTextStep(previous, job) {
    if (
      !previous?.shared ||
      previous.jobId !== job.id ||
      previous.account !== job.account ||
      previous.target !== job.target ||
      !previous.textEnterProof ||
      !previous.draft ||
      previous.textStage !== 'pasted'
    )
      return false;
    nativeTextProof(previous.textEnterProof, previous.draft);
    if (JSON.stringify(previous.stepBinding) !== JSON.stringify(this.textStepBinding(job)))
      throw fault('UI_QT_TEXT_STEP_BINDING_INVALID');
    return true;
  }
  async resumeTextStep(previous, job, frame) {
    if (
      !this.resumableTextStep(previous, job) ||
      !sharedTargetProof(previous.privateChatProof) ||
      previous.privateChatProof.account !== job.account ||
      previous.privateChatProof.target !== job.target ||
      frame.popup ||
      frame.regions.length !== 2 ||
      !previous.binding ||
      !['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi'].every(
        key => frame.binding[key] === previous.binding[key],
      ) ||
      !['clientRect', 'captureRect'].every(key => sameRect(frame.binding[key], previous.binding[key])) ||
      this.#frames.regionDigest(frame, 0) !== previous.header
    )
      throw fault('UI_QT_PARTIAL_DRAFT_RECHECK_REQUIRED');
    // Resume the completed paste, not the entire delivery. Native refocuses the
    // original editor and rebinds its saved input proof to this transaction;
    // it does not copy, search, paste or send a second time.
    const result = await this.requestNative('resumeTextEnterProof', {
      token: frame.token,
      epoch: frame.epoch,
      revision: frame.revision,
      idleMs: this.config.idleMs,
      textEnterProofId: previous.textEnterProof.id,
      textSha256: previous.textEnterProof.textSha256,
      stepBinding: this.textStepBinding(job),
      headerRect: this.config.layout.header,
      editorRect: this.config.layout.editor,
    });
    if (
      result.performed !== true ||
      result.attempted !== true ||
      result.resumed !== true ||
      result.revision !== frame.revision
    )
      throw fault('UI_QT_TEXT_RESUME_UNVERIFIED');
    const resumed = this.#frames.acceptPostPasteFrame(result.postPasteFrame, frame, ['header', 'editor']),
      proof = nativeTextProof(result.textEnterProof, previous.draft);
    this.#current = {
      ...previous,
      epoch: resumed.epoch,
      revision: resumed.revision,
      binding: structuredClone(resumed.binding),
      header: this.#frames.regionDigest(resumed, 0),
      editor: this.#frames.regionDigest(resumed, 1),
      editorToken: crypto.randomUUID(),
      verifiedAt: this.now(),
      textEnterProof: proof,
    };
    this.sharedDraftResume = null;
    this.#draftHold = null;
    return {
      ready: true,
    };
  }
  async prepare(
    job,
    {
      signal,
      textEntryMode = 'humanized',
      interactionPlan = {
        executionMode: 'focus-handoff',
      },
      [preparedTargetLookup]: backgroundTarget,
      [sharedVoicePreparation]: voicePreparation,
    } = {},
  ) {
    if (
      job.quote &&
      ((interactionPlan?.executionMode !== 'focus-handoff' && interactionPlan?.sendMode !== 'focus-handoff') ||
        typeof job.quote.text !== 'string' ||
        !job.quote.text ||
        job.quote.text.length > 4096 ||
        !/^[1-9]\d{0,19}$/.test(job.quote.serverId))
    )
      throw fault('UI_QUOTE_TARGET_UNAVAILABLE', {
        attempted: false,
        quoteDraftUntouched: true,
      });
    if (!['humanized', 'paste'].includes(textEntryMode)) throw fault('UI_QT_TEXT_ENTRY_MODE_INVALID');
    this.checkJob(job);
    if (this.#busy) throw fault('UI_QT_BUSY');
    if (
      !observedLayout(this.config) ||
      !(interactionPlan?.executionMode === 'focus-handoff' || interactionPlan?.sendMode === 'focus-handoff')
    )
      throw fault('UI_QT_CONTROLS_POLICY_INVALID');
    const imageDraft = this.#current ?? this.#textResume;
    if (imageDraft?.imageApplied)
      throw fault(imageDraft.jobId === job.id ? 'UI_QT_IMAGE_RESUME_REQUIRED' : 'UI_QT_DRAFT_CONFLICT');

    const previous = this.#current ?? this.#textResume ?? this.sharedDraftResume;
    // Preparation evidence belongs to this attempt; only a verified conversation can publish a draft checkpoint.
    const preparation = {
      previous,
      signal,
      voicePreparation,
      completedNavigation: this.#completedTextNavigation,
      borrowedFocus: Boolean(this.#focus.preparationLease()),
      unborrowedForeground: false,
      partialResume: Boolean(
        previous?.shared &&
        previous.jobId === job.id &&
        previous.account === job.account &&
        previous.target === job.target &&
        (job.index > 0 || job.pendingInput || previous.textStage === 'pasted'),
      ),
    };
    this.#busy = true;
    this.#completedTextNavigation = null;
    this.#textResume = null;
    this.#operationSignal = signal;
    const abort = () => {
      preparation.cleanup ??= Promise.resolve(this.#native.close());
      preparation.cleanup.catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      this.#assertPreparationDraft(job, preparation);
      if (await this.#reusePreparedDraft(job, previous, signal)) return { ready: true };
      const { resumed, conversation } = await this.#conversation.select(job, preparation, backgroundTarget);
      if (resumed) return resumed;
      return await this.#finishPreparation(job, conversation, textEntryMode, signal);
    } catch (error) {
      return await this.#recoverPreparation(job, preparation, error);
    } finally {
      signal?.removeEventListener('abort', abort);
      this.#operationSignal = null;
      this.#busy = false;
      if (preparation.cleanup) {
        await preparation.cleanup;
        this.#current = null;
        this.#frames.invalidateFrame();
        this.#frames.clearTransaction();
        if (!this.closed) this.#native.renew();
      }
    }
  }
  #assertPreparationDraft(job, { previous, partialResume }) {
    this.active();
    if (this.textSubmitAttempted === job.id) throw fault('UI_QT_TEXT_SUBMIT_UNCERTAIN');
    if (this.#draftHold && !partialResume)
      throw fault(
        this.#draftHold.account === job.account && this.#draftHold.target === job.target
          ? 'UI_QT_PARTIAL_DRAFT_RECHECK_REQUIRED'
          : 'UI_QT_DRAFT_CONFLICT',
      );
    if (previous?.shared && previous.draft && previous.jobId !== job.id) throw fault('UI_QT_DRAFT_CONFLICT');
    if (previous && (previous.account !== job.account || previous.target !== job.target) && previous.draft)
      throw fault('UI_QT_DRAFT_CONFLICT');
  }
  async #reusePreparedDraft(job, previous, signal) {
    if (job.quote && previous === this.#current && previous?.jobId === job.id && previous.quoteToken) {
      if (previous.quoteServerId !== job.quote.serverId || this.#focus.preparationLease()?.parked)
        throw fault('UI_QT_QUOTE_DRAFT_CONFLICT');
      const observed = await this.observe(job);
      if (!observed.ready) throw fault(observed.reason);
      const f = this.frame,
        proof = await this.requestNative('verifyMessageQuote', {
          token: f.token,
          epoch: f.epoch,
          revision: f.revision,
          idleMs: this.config.idleMs,
          stepBinding: this.textStepBinding(job),
          quoteToken: previous.quoteToken,
        });
      if (proof?.verified !== true) throw fault('UI_QT_QUOTE_PREVIEW_UNVERIFIED');
      await this.verifyControlBinding(job, f, 'prepare', signal);
      return true;
    }
    // A paste already returned the intended prefix and a native one-use
    // submit proof. Do not park or copy that same draft on each tick.
    if (
      previous === this.#current &&
      previous?.shared &&
      previous.jobId === job.id &&
      previous.account === job.account &&
      previous.target === job.target &&
      previous.textEnterProof &&
      !this.#focus.preparationLease()?.parked
    ) {
      nativeTextProof(previous.textEnterProof, previous.draft);
      const observed = await this.observe(job);
      if (observed.ready && observed.idleMs >= this.config.idleMs) {
        await this.verifyControlBinding(job, this.frame, 'prepare', signal);
        return true;
      }
      await this.#focus.releaseTextFocus();
    }

    return false;
  }
  async #finishPreparation(job, conversation, textEntryMode, signal) {
    const { verified, privateChatProof, continuationFingerprint, recovering, fileTitleSha256 } = conversation;
    await this.#editor.verifyNew(job, verified, signal);
    const { quoteToken, quoteNavigation } = await this.#quotes.prepare(job, verified, signal);
    this.#current = {
      jobId: job.id,
      account: job.account,
      target: job.target,
      draft: verified.draft,
      epoch: verified.frame.epoch,
      revision: verified.frame.revision,
      binding: structuredClone(verified.frame.binding),
      ...(continuationFingerprint
        ? {
            uiaConversationFingerprint: continuationFingerprint,
          }
        : {}),
      header: this.#frames.regionDigest(verified.frame, 0),
      editor: this.#frames.regionDigest(verified.frame, 1),
      editorToken: crypto.randomUUID(),
      verifiedAt: this.now(),
      privateChatProof,
      fileTitleSha256,
      shared: true,
      textEntryMode,
      ...{
        draftPolicy: 'unchecked',
        textStage: 'focused',
      },
      textEnterProof: verified.textEnterProof,
      ...(verified.textEnterProof
        ? {
            textStage: 'pasted',
            stepBinding: this.textStepBinding(job),
          }
        : {}),
      verifiedEmptyHashes: verified.verifiedEmptyHashes,
      emptyDraftPhaseProof: verified.emptyDraftPhaseProof,
      verifiedEmptyPhase: verified.verifiedEmptyPhase,
    };
    this.sharedDraftResume = null;
    if (recovering) this.#draftHold = null;
    if (quoteToken) {
      this.#current.quoteToken = quoteToken;
      this.#current.quoteServerId = job.quote.serverId;
    }
    return {
      ready: true,
      ...(quoteNavigation
        ? {
            quoteNavigation,
          }
        : {}),
    };
  }
  async #recoverPreparation(job, preparation, error) {
    const {
      previous,
      signal,
      voicePreparation,
      borrowedFocus,
      unborrowedForeground,
      backgroundAccountFailure,
      focusPreflightFailure,
      cleanup,
    } = preparation;
    // Retain the original transaction until its own profile popup has been
    // safely dismissed. Resetting the surface first loses that authority and
    // leaves the foreground lease unable to return focus from an open popup.
    const failedSurface = this.surface;
    let popupCleanupUnattempted = false;
    try {
      const cleanup = await this.closePreparationPopupAfterFailure();
      popupCleanupUnattempted = cleanup.attempted === false;
      if (cleanup.attempted) error.popupCleanup = cleanup;
    } catch (cleanupError) {
      error.popupCleanup = {
        closed: false,
        code: codeFor(cleanupError),
      };
    }
    // Losing the verified session must not erase knowledge of an existing
    // draft. In particular a later tick cannot navigate another chat after a
    // draft conflict or silently continue a partially typed message.
    if (previous?.draft)
      this.#draftHold = {
        account: previous.account,
        target: previous.target,
      };
    else if (job.index > 0 || job.pendingInput)
      this.#draftHold = {
        account: job.account,
        target: job.target,
      };
    if (
      previous?.shared &&
      this.textSubmitAttempted !== job.id &&
      (previous.draft || job.index > 0 || job.pendingInput)
    )
      this.sharedDraftResume = previous;
    this.#current = null;
    this.#frames.clearTransaction();
    this.#frames.invalidateFrame('main');
    const returned = await this.#focus.releaseTextFocus();
    if (
      failedSurface === 'main' &&
      popupCleanupUnattempted &&
      this.#canIsolateTextDraft(job, previous, error) &&
      this.#isolateTextDraft(job, returned)
    )
      return { ready: false, reason: codeFor(error), inputReleased: true };
    const pristineDraft =
      job.index === 0 &&
      !job.pendingInput &&
      !previous?.draft &&
      !previous?.imageApplied &&
      previous?.textStage !== 'pasted' &&
      !this.#draftHold &&
      this.textSubmitAttempted !== job.id;
    if (
      error.quoteDraftUntouched &&
      (error.popupCleanup?.closed === false ||
        (borrowedFocus && !(returned?.released === true && returned.restored && !returned.skipped)))
    )
      delete error.quoteDraftUntouched;
    if (
      error.originalClipboardBlocked === true &&
      error.attempted === false &&
      error.clipboardRestored === true &&
      (error.popupCleanup?.closed === true || (failedSurface === 'main' && popupCleanupUnattempted)) &&
      !voicePreparation &&
      !this.#focus.preparationLease() &&
      !cleanup &&
      !signal?.aborted &&
      !error.controlsCleanupFailed &&
      pristineDraft &&
      (borrowedFocus
        ? returned?.released === true && returned.restored === true && returned.skipped === false
        : unborrowedForeground)
    )
      return {
        ready: false,
        reason: codeFor(error),
        clipboardPreparationClean: true,
      };
    if (
      focusPreflightFailure === error &&
      !borrowedFocus &&
      !this.#focus.preparationLease() &&
      !voicePreparation &&
      !signal?.aborted &&
      !cleanup &&
      failedSurface === 'main' &&
      popupCleanupUnattempted &&
      error.attempted === false &&
      error.inputSent !== true &&
      error.clipboardRestored !== false &&
      !error.controlsCleanupFailed &&
      error.popupCleanup?.closed !== false &&
      pristineDraft
    )
      return {
        ready: false,
        reason: codeFor(error),
        attempted: false,
        focusPreflightClean: true,
      };
    const uiaRefusal = error?.[uiaVerificationRefusal];
    if (
      uiaRefusal &&
      !voicePreparation &&
      !this.#focus.preparationLease() &&
      !signal?.aborted &&
      !cleanup &&
      pristineDraft &&
      error.attempted === false &&
      error.inputSent !== true &&
      !error.controlsCleanupFailed &&
      error.clipboardRestored !== false &&
      error.popupCleanup?.closed !== false &&
      (uiaRefusal.focus === 'restored' || (!borrowedFocus && uiaRefusal.focus === 'not-borrowed'))
    )
      error.uiaPreparationRefusal = {
        version: 1,
        stage: 'control-preparation',
        operation: uiaRefusal.operation,
        focus: uiaRefusal.focus,
        messageInputAttempted: false,
        draftPresent: false,
        cleanupConfirmed: true,
      };
    if (
      backgroundAccountFailure === error &&
      !borrowedFocus &&
      !this.#focus.preparationLease() &&
      !voicePreparation &&
      !signal?.aborted &&
      popupCleanupUnattempted &&
      error.attempted !== true &&
      error.inputSent !== true &&
      error.clipboardRestored !== false &&
      error.popupCleanup?.closed !== false
    )
      error.accountPreflightRefusal = {
        version: 1,
        stage: 'background-account',
        focusBorrowed: false,
        voiceLeasePresent: false,
        messageInputAttempted: false,
        cleanupRequired: false,
      };
    // A failed contact-navigation observation never submitted a chat body.
    // Only a confirmed return (or a session that never borrowed focus) lets
    // the queue pause this delivery while its message reader keeps running.
    // A shared voice lease is still owned by the outer voice preparation.
    if (!this.#focus.preparationLease()) {
      if (borrowedFocus && returned?.released === true && returned.restored === true && returned.skipped === false)
        markNavigationRefusal(error, 'restored');
      else if (unborrowedForeground) markNavigationRefusal(error, 'not-borrowed');
    }
    if (preparationWaits.has(codeFor(error)) && error?.clipboardRestored !== false)
      return {
        ready: false,
        reason: codeFor(error),
        ...clipboardFailureDiagnostic(error),
      };
    throw error;
  }
  async observe(job) {
    this.checkJob(job);
    const current = this.#current;
    if (
      !current ||
      current.jobId !== job.id ||
      current.account !== job.account ||
      current.target !== job.target ||
      this.now() - current.verifiedAt > 30000
    )
      return {
        ready: false,
        reason: 'UI_QT_PREPARATION_REQUIRED',
      };
    try {
      const dialog = this.#attachments.observeFileDialog(job);
      if (dialog) return { ...dialog, inputProcess: desktopProcessIdentity(current.binding) };
      if (current.imageApplied === job.id) {
        if (this.config.layoutMode === 'uia-v1') {
          if (
            !validUiaImageProof(current.uiaImageProof, job.image) ||
            this.#imageSubmitAttempted === job.id ||
            this.frame !== current.uiaImageFrame
          )
            return {
              ready: false,
              reason: 'UI_QT_IMAGE_APPLICATION_UNKNOWN',
            };
          this.acceptUiaImageFrame(this.frame, current);
          // This reports the retained paste intent, not attachment contents.
          // Fresh UIA and native activity checks still precede the next input.
          return {
            ready: true,
            account: job.account,
            target: job.target,
            foreground: true,
            inputEnabled: true,
            idleMs: this.frame.idleMs,
            editorToken: current.editorToken,
            activityRevision: current.revision,
            inputProcess: desktopProcessIdentity(this.frame.binding),
            appliedImageId: job.id,
          };
        }
        const frame = await this.#frames.capture([
          'header',
          ['gif', 'file'].includes(current.imageFormat) ? 'send' : 'editor',
        ]);
        if (this.#frames.regionDigest(frame, 0) !== current.header)
          return {
            ready: false,
            reason: 'UI_QT_HEADER_CHANGED',
          };
        return {
          ready: true,
          account: job.account,
          target: job.target,
          foreground: true,
          inputEnabled: true,
          idleMs: frame.idleMs,
          editorToken: current.editorToken,
          activityRevision: current.revision,
          inputProcess: desktopProcessIdentity(frame.binding),
          appliedImageId: job.id,
        };
      }
      if (current.draftPolicy === 'unchecked') {
        if (!this.frame || this.surface !== 'main')
          return {
            ready: false,
            reason: 'UI_QT_PREPARATION_REQUIRED',
          };
        this.#frames.assertTransaction(this.frame);
        // This is this delivery's applied input prefix, not copied editor text.
        // The next native input validates actual focus and activity itself.
        return {
          ready: true,
          account: job.account,
          target: job.target,
          foreground: true,
          inputEnabled: true,
          idleMs: this.frame.idleMs,
          draft: current.draft,
          draftPolicy: 'unchecked',
          editorToken: current.editorToken,
          activityRevision: current.revision,
          inputProcess: desktopProcessIdentity(current.binding),
        };
      }
      const frame = await this.#frames.capture(['header', 'editor']);
      if (
        this.#frames.regionDigest(frame, 0) !== current.header ||
        this.#frames.regionDigest(frame, 1) !== current.editor
      )
        return {
          ready: false,
          reason: 'UI_QT_DRAFT_RECHECK_REQUIRED',
        };
      return {
        ready: true,
        account: job.account,
        target: job.target,
        foreground: true,
        inputEnabled: true,
        idleMs: frame.idleMs,
        draft: current.draft,
        editorToken: current.editorToken,
        activityRevision: current.revision,
        inputProcess: desktopProcessIdentity(current.binding),
      };
    } catch (error) {
      return {
        ready: false,
        reason: codeFor(error),
        ...clipboardFailureDiagnostic(error),
      };
    }
  }
  async #verifiedSubmitFrame(job, current) {
    if (
      this.config.layoutMode !== 'adaptive-v1' ||
      !current.shared ||
      current.draftPolicy !== 'unchecked' ||
      current.textEntryMode !== 'humanized'
    )
      return this.frame;
    const { frame, textEnterProof } = await this.#editor.verifyTypedForSubmit(
      job,
      current.draft,
      current.textEnterProof,
    );
    current.textEnterProof = textEnterProof;
    current.header = this.#frames.regionDigest(frame, 0);
    current.editor = this.#frames.regionDigest(frame, 1);
    current.binding = structuredClone(frame.binding);
    return frame;
  }
  #canIsolateTextDraft(job, current, error) {
    return (
      !job.quote &&
      !job.pendingInput &&
      current?.shared === true &&
      current.jobId === job.id &&
      Boolean(current.draft && current.textEnterProof) &&
      sharedTargetProof(current.privateChatProof) &&
      current.privateChatProof.account === job.account &&
      current.privateChatProof.target === job.target &&
      this.textSubmitAttempted !== job.id &&
      !this.#focus.voiceFocusLease &&
      !error.controlsCleanupFailed &&
      (error.clipboardRestored === true || (error.attempted === false && error.clipboardRestored !== false)) &&
      textDraftRequiresReview(error.code)
    );
  }
  #isolateTextDraft(job, returned) {
    if (!(
      returned?.restored === true ||
      returned?.released === false ||
      returned?.inPlace === true ||
      returned?.focusRestoreOutcome?.foregroundOwnedByWechat === false
    ))
      return false;
    this.#current = null;
    if (this.#textResume?.jobId === job.id) this.#textResume = null;
    if (this.sharedDraftResume?.jobId === job.id) this.sharedDraftResume = null;
    if (this.#draftHold?.account === job.account && this.#draftHold?.target === job.target) this.#draftHold = null;
    return true;
  }
  async sendAction(action, job, guard, local = {}) {
    if (local.beforeSubmit !== undefined && (action !== 'submit' || typeof local.beforeSubmit !== 'function'))
      throw fault('UI_RECEIPT_BARRIER_INVALID');
    this.#completedTextNavigation = null;
    this.checkJob(job);
    const current = this.#current;
    if (
      action === 'paste' &&
      (typeof guard?.text !== 'string' || !guard.text || guard.text.length > 16000 || guard.text.includes('\0'))
    )
      return {
        performed: false,
        attempted: false,
        reason: 'UI_QT_PASTE_INVALID',
      };
    if (
      !current ||
      current.account !== job.account ||
      current.target !== job.target ||
      guard?.expectedDraft !== current.draft ||
      guard.editorToken !== current.editorToken ||
      guard.activityRevision !== current.revision
    )
      return {
        performed: false,
        attempted: false,
        reason: 'UI_QT_DRAFT_CHANGED',
      };
    if (action === 'submit' && !this.allowSubmit)
      return {
        performed: false,
        attempted: false,
        reason: 'UI_SUBMIT_DISABLED',
      };
    if (
      (job.quote || current.quoteToken) &&
      (!job.quote || !current.quoteToken || current.quoteServerId !== job.quote.serverId || !current.shared)
    )
      return {
        performed: false,
        attempted: false,
        reason: 'UI_QT_QUOTE_PREVIEW_UNVERIFIED',
      };
    if (action === 'type' && guard.text === '\n' && this.config.newlineKey !== 'Shift+Enter')
      return {
        performed: false,
        attempted: false,
        reason: 'UI_QT_NEWLINE_CALIBRATION_REQUIRED',
      };
    let attempted = false,
      inputAccepted = false;
    try {
      // Shared preparation already proved this account/process transaction.
      // Parking focus here would revoke the one-use post-paste native proof.
      if (!current.shared) await this.freshAccount();
      const observation = await this.observe(job);
      if (observation.ready !== true)
        return {
          performed: false,
          attempted: false,
          reason: observation.reason,
        };
      if (typeof guard.canSubmit === 'function' && action === 'submit' && !guard.canSubmit())
        return {
          performed: false,
          attempted: false,
          reason: 'UI_TARGET_NOT_ALLOWED',
        };
      if ((action === 'paste' || action === 'type') && typeof guard.canInput !== 'function')
        return {
          performed: false,
          attempted: false,
          reason: 'UI_QT_INPUT_AUTHORIZATION_REQUIRED',
        };
      const frame = action === 'submit' ? await this.#verifiedSubmitFrame(job, current) : this.frame;
      await this.verifyControlBinding(job, frame, action === 'submit' ? 'text-submit' : 'text-input', guard.signal);
      if (action === 'submit' && local.beforeSubmit) {
        const receipt = await local.beforeSubmit();
        if (
          !object(receipt) ||
          Object.keys(receipt).length !== 2 ||
          receipt.ready !== true ||
          receipt.proof !== 'receipt-baseline-persisted-v1'
        )
          throw fault('UI_RECEIPT_BARRIER_UNCONFIRMED');
        // The receipt wait grants no UI authority. The original transaction,
        // current permission and native one-use frame still govern input.
        this.active();
        this.#frames.assertTransaction(frame);
        if (guard.signal?.aborted) throw fault('UI_QT_CANCELLED');
      }
      this.active();
      if (action === 'submit' && typeof guard.canSubmit === 'function' && guard.canSubmit() !== true)
        return {
          performed: false,
          attempted: false,
          reason: 'UI_TARGET_NOT_ALLOWED',
        };
      if ((action === 'paste' || action === 'type') && guard.canInput() !== true)
        return {
          performed: false,
          attempted: false,
          reason: 'UI_TARGET_NOT_ALLOWED',
        };
      // Keep the outbox's write-ahead intent authoritative. Any failure after
      // entering native input remains uncertain; this layer never retries.
      const { typed, enterSubmit, name, values } = textCommand(action, guard.text, current, frame, {
        config: this.config,
        allowClipboardReplacement: this.allowClipboardReplacement,
        foregroundOnly: !this.#focus.preparationLease(),
        stepBinding: () => this.textStepBinding(job),
      });
      attempted = true;
      const result = await this.requestNative(name, values);
      inputAccepted = true;
      if (action === 'submit') {
        this.textSubmitAttempted = job.id;
        this.#textResume = null;
        this.sharedDraftResume = null;
      }
      this.#frames.invalidateFrame();
      this.#current = null;
      if (result.attempted !== true || result.performed !== true) throw fault('UI_QT_INPUT_UNCERTAIN');
      if (enterSubmit && result.submittedViaEnter !== true) throw fault('UI_QT_INPUT_UNCERTAIN');
      if (action === 'type' || action === 'paste') {
        const fast = (action === 'paste' || typed) && current.draftPolicy === 'unchecked',
          expected = current.draft + guard.text;
        if (fast) {
          if (typed) this.appliedTypedText(result, expected);
          else this.appliedPaste(result, expected);
          if (result.interrupted) {
            if (result.postPasteFrame !== undefined) throw fault('UI_QT_PASTE_UNCONFIRMED');
            this.#current = {
              ...current,
              draft: expected,
              textStage: 'pasted',
              stepBinding: this.textStepBinding(job),
              textEnterProof: nativeTextProof(result.textEnterProof, expected),
              editorToken: crypto.randomUUID(),
              verifiedAt: this.now(),
            };
            this.sharedDraftResume = this.#current;
            await this.#focus.releaseTextFocus();
            return {
              performed: true,
              attempted: true,
            };
          }
        } else if (
          action === 'paste' &&
          (result.pasteVerified !== true ||
            !clipboardSettled(result, this.allowClipboardReplacement) ||
            result.draft !== expected)
        )
          throw fault('UI_QT_PASTE_UNVERIFIED');
        const verified =
          (action === 'paste' || typed) && current.shared
            ? {
                draft: fast ? expected : result.draft,
                frame: this.#frames.acceptPostPasteFrame(
                  result.postPasteFrame,
                  frame,
                  ['header', 'editor'],
                  fast
                    ? {
                        conversationFingerprint: current.uiaConversationFingerprint,
                      }
                    : {},
                ),
                textEnterProof: nativeTextProof(result.textEnterProof, fast ? expected : result.draft),
              }
            : await this.#editor.readDraft(job);
        this.#current = {
          ...current,
          draft: verified.draft,
          binding: structuredClone(verified.frame.binding),
          header: this.#frames.regionDigest(verified.frame, 0),
          editor: this.#frames.regionDigest(verified.frame, 1),
          editorToken: crypto.randomUUID(),
          verifiedAt: this.now(),
          textEnterProof: verified.textEnterProof,
          ...(current.shared && verified.textEnterProof
            ? {
                textStage: 'pasted',
                stepBinding: this.textStepBinding(job),
              }
            : {}),
          // Paced input updates the expected prefix but keeps the blank
          // baseline needed for the final protected clipboard readback.
          verifiedEmptyHashes: verified.verifiedEmptyHashes ?? current.verifiedEmptyHashes,
          emptyDraftPhaseProof: verified.emptyDraftPhaseProof,
          verifiedEmptyPhase: verified.verifiedEmptyPhase,
        };
      }
      if (
        action === 'submit' &&
        current.shared &&
        sharedTargetProof(current.privateChatProof) &&
        current.privateChatProof.account === job.account &&
        current.privateChatProof.target === job.target
      ) {
        const binding = Object.fromEntries(
          ['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi'].map(key => [key, current.binding[key]]),
        );
        for (const key of ['clientRect', 'captureRect']) binding[key] = structuredClone(current.binding[key]);
        this.#completedTextNavigation = {
          account: job.account,
          target: job.target,
          accountRef: this.config.accountRef,
          epoch: current.epoch,
          revision: current.revision,
          binding,
          header: current.header,
          verifiedAt: this.now(),
          privateChatProof: structuredClone(current.privateChatProof),
          ...(validConversationFingerprint(current.uiaConversationFingerprint)
            ? {
                uiaConversationFingerprint: structuredClone(current.uiaConversationFingerprint),
              }
            : {}),
        };
      }
      return {
        performed: true,
        attempted: true,
      };
    } catch (error) {
      if (error?.controlsCleanupFailed) throw error;
      const definitelyUnattempted =
        !attempted ||
        (!inputAccepted &&
          error?.attempted === false &&
          (error.clipboardRestored !== false || clipboardSettled(error, this.allowClipboardReplacement)));
      if (action === 'submit' && !definitelyUnattempted) {
        this.textSubmitAttempted = job.id;
        this.#textResume = null;
        this.sharedDraftResume = null;
      } else if (current?.shared && (current.draft || attempted)) this.sharedDraftResume = current;
      this.#current = null;
      this.#frames.invalidateFrame();
      if (definitelyUnattempted && this.#canIsolateTextDraft(job, current, error)) {
        const returned = await this.#focus.releaseTextFocus();
        if (this.#isolateTextDraft(job, returned))
          return { performed: false, attempted: false, reason: codeFor(error), inputReleased: true };
      }
      if (definitelyUnattempted)
        return {
          performed: false,
          attempted: false,
          reason: codeFor(error),
          ...clipboardFailureDiagnostic(error),
        };
      throw fault(codeFor(error));
    }
  }
  typeGrapheme(job, guard, local = {}) {
    return this.sendAction('type', job, {
      ...guard,
      canInput: local.canInput,
    });
  }
  pasteText(job, guard, local = {}) {
    return this.sendAction('paste', job, {
      ...guard,
      canInput: local.canInput,
    });
  }
  canResumeImage(...args) {
    return this.#attachments.canResumeImage(...args);
  }
  acceptUiaImageFrame(...args) {
    return this.#attachments.acceptUiaImageFrame(...args);
  }
  acceptPastedImageGeometry(...args) {
    return this.#attachments.acceptPastedImageGeometry(...args);
  }
  resumeImage(...args) {
    return this.#attachments.resumeImage(...args);
  }
  pasteImage(...args) {
    return this.#attachments.pasteImage(...args);
  }
  submitImage(...args) {
    return this.#attachments.submitImage(...args);
  }
  async submit(job, guard, local = {}) {
    try {
      return await this.sendAction(
        'submit',
        job,
        {
          ...guard,
          ...(typeof local.canSubmit === 'function'
            ? {
                canSubmit: local.canSubmit,
              }
            : {}),
        },
        {
          beforeSubmit: local.beforeSubmit,
        },
      );
    } finally {
      if (local.deferFocusRelease !== true) await this.#focus.releaseTextFocus();
    }
  }
  /** Admission check only: keep a queued reply waiting while the user is active,
   * before the voice outbox writes an irreversible recording intent. */
  prepareVoiceHandoff(...args) {
    return this.#voice.prepareVoiceHandoff(...args);
  }
  prepareVoiceSession(...args) {
    return this.#voice.prepareVoiceSession(...args);
  }
  receipt(job, options) {
    return this.receiptProvider
      ? this.receiptProvider(job, options)
      : Promise.resolve({
          confirmed: false,
        });
  }
  async close() {
    try {
      await this.#focus.releaseTextFocus();
    } finally {
      this.#completedTextNavigation = null;
      this.closed = true;
      this.#current = null;
      await this.#native.close();
    }
  }
}
function createQtVisualDriver({
  root = path.resolve(import.meta.dirname, '../..'),
  configFile = path.join(root, 'state/ui-runtime/qt-visual.json'),
  config,
  client,
  enableInput = false,
  allowSubmit = false,
  requiredIdleMs,
  ...options
} = {}) {
  if (!config) {
    noLinks(configFile);
    const stat = fs.statSync(configFile, {
      throwIfNoEntry: false,
    });
    if (!stat?.isFile() || stat.size > 131072) throw fault('UI_QT_CALIBRATION_REQUIRED');
    try {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch {
      throw fault('UI_QT_CONFIG_INVALID');
    }
  }
  if (
    requiredIdleMs !== undefined &&
    (!Number.isSafeInteger(requiredIdleMs) || requiredIdleMs < 0 || requiredIdleMs > 300000)
  )
    throw fault('UI_QT_CONFIG_INVALID');
  const base = validateQtConfig(config);
  const validated =
    requiredIdleMs === undefined
      ? base
      : validateQtConfig({
          ...base,
          idleMs: Math.max(base.idleMs, requiredIdleMs),
        });
  const clientFactory = () =>
    new QtActionsClient({
      root,
      config: validated,
      enableInput,
    });
  return new QtVisualDriver({
    root,
    config: validated,
    client: client ?? clientFactory(),
    clientFactory,
    allowSubmit,
    ...options,
  });
}
export { QtVisualDriver, createQtVisualDriver };
export { qtEmptyEditorHashes } from './qt-contract.mjs';
export { qtEmptyEditorPhaseMatches } from './qt-contract.mjs';
export { validateQtEmptyDraftPhaseProof } from './qt-contract.mjs';
export { validateQtEmptyDraftPhase } from './qt-contract.mjs';
export { validForegroundSession } from './qt-contract.mjs';
export { validForegroundSessionRelease } from './qt-contract.mjs';
export { toObservedPopupCalibration } from './qt-contract.mjs';
export { validateQtConfig } from './qt-contract.mjs';
export { QtActionsClient } from './qt-actions-client.mjs';
export { confirmQuoteDraftSent } from './quote-draft-state.mjs';
