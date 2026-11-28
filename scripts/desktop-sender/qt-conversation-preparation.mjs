import { validateAccountEvidence } from './account-probe.mjs';
import {
  fault,
  observedLayout,
  rect,
  sameRect,
  sharedTargetProof,
  uiaTargetEvidence,
  validConversationFingerprint,
} from './qt-contract.mjs';
import { isDeepStrictEqual } from 'node:util';
import { pixelMismatchDiagnostic } from './qt-diagnostics.mjs';

// Resolve one conversation against the current window and account. The coordinator commits its draft only after this succeeds.
export class QtConversationPreparation {
  #frames;
  #navigation;
  #focus;
  #input;
  constructor(frames, navigation, focus, input) {
    this.#frames = frames;
    this.#navigation = navigation;
    this.#focus = focus;
    this.#input = input;
  }
  async select(job, preparation, backgroundTarget) {
    const { previous, signal } = preparation;
    const target = await this.#lookupPreparationTarget(job, previous, backgroundTarget, signal);
    await this.#focus.acquireForPreparation(job, preparation, {
      warmLocators: options => this.#navigation.warmUiaLocators(options),
      freshAccount: this.#input.freshAccount,
      resumableTextStep: this.#input.resumableTextStep,
      now: this.#input.now,
    });
    const observed = await this.#observePreparation(job, preparation);
    if (observed.resumed) return { resumed: observed.resumed };
    return { conversation: await this.#prepareConversation(job, preparation, observed, target) };
  }
  async #lookupPreparationTarget(job, previous, backgroundTarget, signal) {
    let targetLookup = backgroundTarget ?? null;
    // Initial contact lookup and model loading are read-only and can finish
    // before borrowing focus. An existing continuation does not re-query.
    if (
      !targetLookup &&
      (job.mode === 'file' ||
        (!(job.index > 0) &&
          !job.pendingInput &&
          (!previous ||
            previous.account !== job.account ||
            previous.target !== job.target ||
            (job.target.endsWith('@chatroom') && previous.jobId !== job.id))))
    ) {
      targetLookup = await this.#navigation.lookupTarget(job, {
        signal,
      });
    }
    this.#input.active();
    if (
      targetLookup &&
      (targetLookup.account !== job.account ||
        targetLookup.target !== job.target ||
        targetLookup.accountRef !== this.#frames.config.accountRef)
    )
      throw fault('UI_QT_TARGET_CHANGED');

    return targetLookup;
  }
  async #observePreparation(job, preparation) {
    const { previous, partialResume, completedNavigation, backgroundAccount, borrowedFocus, signal } = preparation;
    this.#input.resetInputSession('main');
    const resumeStep = this.#input.resumableTextStep(previous, job);
    const settleUiaHeader =
      !!this.#input.verifyControls &&
      !resumeStep &&
      !partialResume &&
      this.#focus.preparationLease()?.uiaInitialHeaderPending === true;
    const uiaNavigation = settleUiaHeader
      ? {
          lease: this.#focus.preparationLease(),
          started: this.#input.now(),
          waited: 0,
        }
      : undefined;
    const checkpointMatches = (frame, semantic = false) =>
      !preparation.voicePreparation &&
      !(job.index > 0) &&
      !job.pendingInput &&
      completedNavigation?.account === job.account &&
      completedNavigation.target === job.target &&
      completedNavigation.accountRef === this.#frames.config.accountRef &&
      this.#input.now() >= completedNavigation.verifiedAt &&
      this.#input.now() - completedNavigation.verifiedAt <= 30000 &&
      completedNavigation.epoch === frame.epoch &&
      completedNavigation.revision === frame.revision &&
      (semantic || completedNavigation.header === this.#frames.regionDigest(frame, 0)) &&
      ['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi'].every(
        key => completedNavigation.binding[key] === frame.binding[key],
      ) &&
      ['clientRect', 'captureRect'].every(key => sameRect(completedNavigation.binding[key], frame.binding[key]));
    let initial,
      checkpointRejected = false,
      semanticContinuation = false,
      continuationFingerprint;
    if (uiaNavigation && this.#frames.navigationPolicy === 'uia-controls-v1' && completedNavigation) {
      initial = await this.#frames.captureUiaNavigation();
      this.#navigation.assertUiaInitialHeader(uiaNavigation, initial);
      if (
        checkpointMatches(initial, true) &&
        validConversationFingerprint(completedNavigation.uiaConversationFingerprint)
      ) {
        const proof = await this.#input.verifyControlBinding(job, initial, 'navigation-continuation', signal);
        semanticContinuation =
          validConversationFingerprint(proof?.conversationFingerprint) &&
          isDeepStrictEqual(proof.conversationFingerprint, completedNavigation.uiaConversationFingerprint);
        if (semanticContinuation) continuationFingerprint = structuredClone(proof.conversationFingerprint);
      }
      // A title fingerprint is only a continuation of this already verified
      // target and activity generation, never independent target identity.
      checkpointRejected = !semanticContinuation;
    } else if (uiaNavigation && completedNavigation) {
      try {
        initial = await this.#frames.capture(['header'], false, {
          retryPixelChanges: false,
        });
        this.#navigation.assertUiaInitialHeader(uiaNavigation, initial);
      } catch (error) {
        const mismatch = pixelMismatchDiagnostic(error?.pixelMismatch);
        if (
          error?.code !== 'QT_PIXELS_CHANGED' ||
          error.attempted !== false ||
          mismatch?.stage !== 'capture' ||
          mismatch.anchorIndex !== 0
        )
          throw error;
      }
      if (initial && !checkpointMatches(initial)) checkpointRejected = true;
      if (!initial || checkpointRejected)
        initial = await this.#navigation.stableUiaInitialHeader(uiaNavigation.lease, {
          context: uiaNavigation,
        });
    } else
      initial = uiaNavigation
        ? this.#frames.navigationPolicy === 'uia-controls-v1'
          ? await this.#frames.captureUiaNavigation()
          : await this.#navigation.stableUiaInitialHeader(uiaNavigation.lease, {
              context: uiaNavigation,
              firstOnly: true,
            })
        : await this.#frames.capture(resumeStep ? ['header', 'editor'] : ['header']);
    if (uiaNavigation) uiaNavigation.lease.uiaInitialHeaderPending = false;
    if (backgroundAccount) {
      if (
        !['hwnd', 'pid', 'processCreatedFileTimeUtc', 'dpi'].every(
          key => initial.binding[key] === backgroundAccount.binding[key],
        ) ||
        !['clientRect', 'captureRect'].every(key => sameRect(initial.binding[key], backgroundAccount.binding[key]))
      )
        throw fault('QT_BINDING_CHANGED');
      if (
        this.#input.now() - Date.parse(backgroundAccount.proof.evidence.observedAtUtc) >
        backgroundAccount.proof.evidence.maximumEvidenceAgeMs
      ) {
        // Activation and a verified frame can take longer than the account
        // proof's lifetime in either mode. Refresh the read-only evidence for
        // this exact window before releasing or attempting any input.
        backgroundAccount.proof = await this.#input.freshAccount({
          frame: initial,
          park: false,
        });
        this.#input.active();
      }
      validateAccountEvidence(backgroundAccount.proof.evidence, initial.binding, this.#input.now());
      this.#input.active();
      if (uiaNavigation)
        uiaNavigation.validateAccount = async frame => {
          if (
            this.#input.now() - Date.parse(backgroundAccount.proof.evidence.observedAtUtc) >
            backgroundAccount.proof.evidence.maximumEvidenceAgeMs
          )
            backgroundAccount.proof = await this.#input.freshAccount({
              frame,
              park: false,
            });
          validateAccountEvidence(backgroundAccount.proof.evidence, frame.binding, this.#input.now());
          this.#input.active();
        };
    }
    preparation.unborrowedForeground =
      !borrowedFocus &&
      (!this.#focus.preparationLease() || this.#focus.preparationLease().inPlace) &&
      initial.binding.foreground === true;
    if (initial.idleMs < this.#frames.config.idleMs) throw fault('UI_USER_ACTIVE');
    this.#frames.bindInputTransaction(initial);
    if (resumeStep) {
      const resumed = await this.#input.resumeTextStep(previous, job, initial);
      if (resumed?.ready === true) await this.#input.verifyControlBinding(job, this.#frames.frame, 'prepare', signal);
      return { resumed };
    }

    return {
      initial,
      uiaNavigation,
      checkpointMatches,
      checkpointRejected,
      semanticContinuation,
      continuationFingerprint,
    };
  }
  async #prepareConversation(job, preparation, observed, targetLookup) {
    const { previous, partialResume, completedNavigation, backgroundAccount, signal } = preparation;
    const { initial, uiaNavigation, checkpointMatches, checkpointRejected, semanticContinuation } = observed;
    let { voicePreparation } = preparation;
    let { continuationFingerprint } = observed;
    let uiaReadyFrame;
    if (voicePreparation?.lease !== this.#focus.voiceFocusLease)
      voicePreparation = preparation.voicePreparation = undefined;
    if (!voicePreparation && !backgroundAccount)
      await this.#input.freshAccount({
        frame: initial,
        park: false,
      });
    // A same-contact continuation only keeps its identity if there has been no
    // human activity, process restart or header change since the verified read.
    const recovering = partialResume;
    if (recovering && previous.draftPolicy === 'unchecked') throw fault('UI_QT_TEXT_STEP_UNAVAILABLE');
    if (
      recovering &&
      (!previous.binding ||
        !['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi'].every(
          key => initial.binding[key] === previous.binding[key],
        ) ||
        !['clientRect', 'captureRect'].every(key => sameRect(initial.binding[key], previous.binding[key])) ||
        this.#frames.regionDigest(initial, 0) !== previous.header ||
        !sharedTargetProof(previous.privateChatProof))
    )
      throw fault('UI_QT_PARTIAL_DRAFT_RECHECK_REQUIRED');
    // A completed send retains navigation evidence only, never its body,
    // draft or input token. Reuse it once while this exact window, activity
    // generation and displayed header still match the already acquired frame.
    const completedContinuation = !checkpointRejected && (semanticContinuation || checkpointMatches(initial));
    let continuation =
      completedContinuation ||
      (previous?.account === job.account &&
        previous.target === job.target &&
        previous.epoch === initial.epoch &&
        previous.revision === initial.revision &&
        previous.header === this.#frames.regionDigest(initial, 0) &&
        sharedTargetProof(previous.privateChatProof) &&
        previous.privateChatProof.account === job.account &&
        previous.privateChatProof.target === job.target);
    let privateChatProof = completedContinuation
      ? completedNavigation.privateChatProof
      : continuation || recovering
        ? previous.privateChatProof
        : null;
    if (
      !continuation &&
      !recovering &&
      this.#frames.config.layoutMode === 'adaptive-v1' &&
      !(job.index > 0) &&
      !job.pendingInput
    ) {
      targetLookup ??= await this.#navigation.lookupTarget(job, { signal });
      privateChatProof = await this.#navigation.currentOcrChat(job, initial, targetLookup);
      if (privateChatProof) {
        continuation = true;
        if (voicePreparation) voicePreparation.start(initial);
        else await this.#input.sharedAction('click', { rect: this.#frames.config.layout.editor }, ['header'], initial);
      }
    }
    if (completedContinuation) {
      if (semanticContinuation) {
        const result = await this.#input.sharedAction(
            'focusUiaEditor',
            {
              editorRect: this.#frames.config.layout.editor,
            },
            ['header'],
            initial,
          ),
          frame = result.postFocusFrame;
        this.#frames.assertTransaction(frame);
        if (
          result.editorFocused !== true ||
          frame.uiaControlFrame !== true ||
          frame.navigationOnly === true ||
          frame.popup ||
          frame.regions.length !== 2 ||
          !sameRect(frame.regions[0].rect, this.#frames.config.layout.header) ||
          !sameRect(frame.regions[1].rect, this.#frames.config.layout.editor) ||
          !['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi'].every(
            key => frame.binding[key] === initial.binding[key],
          ) ||
          !['clientRect', 'captureRect'].every(key => sameRect(frame.binding[key], initial.binding[key]))
        )
          throw fault('UI_QT_CONTROLS_BINDING_CHANGED');
        uiaReadyFrame = this.#frames.rememberFrame(frame);
      } else
        await this.#input.sharedAction(
          'click',
          {
            rect: this.#frames.config.layout.editor,
          },
          ['header'],
          initial,
        );
    }
    if (
      !continuation &&
      !recovering &&
      uiaNavigation &&
      this.#frames.config.layoutMode === 'uia-v1' &&
      uiaTargetEvidence(targetLookup) &&
      targetLookup.uiaTarget.proof === 'database-unique-display-name-v1'
    ) {
      const currentChat = await this.#navigation.uiaConversationReady(job, initial, targetLookup);
      if (currentChat.ready) {
        voicePreparation?.start(initial);
        const focused = await this.#input.sharedAction(
          'focusUiaEditor',
          {
            editorRect: this.#frames.config.layout.editor,
          },
          ['header'],
          initial,
        );
        uiaReadyFrame = this.#frames.acceptUiaEditorFocus(focused, initial);
        if (voicePreparation) voicePreparation.readyFrame = uiaReadyFrame;
        continuationFingerprint = structuredClone(currentChat.proof.conversationFingerprint);
        continuation = true;
        privateChatProof = Object.freeze({
          kind: 'uia-database-title-v1',
          account: job.account,
          target: job.target,
          querySha256: targetLookup.uiaTarget.querySha256,
          titleSha256: targetLookup.uiaTarget.titleSha256,
          header: this.#frames.regionDigest(uiaReadyFrame, 0),
          searchKind: targetLookup.searchKind,
        });
      }
    }
    if (!continuation && !recovering) {
      if (!observedLayout(this.#frames.config) && !rect(this.#frames.config.layout.searchResultIdentity))
        throw fault('UI_QT_SEARCH_IDENTITY_CALIBRATION_REQUIRED');
      if (job.index > 0 || job.pendingInput) throw fault('UI_QT_PARTIAL_DRAFT_RECHECK_REQUIRED');
      const lookup =
          targetLookup ??
          (await this.#navigation.lookupTarget(job, {
            signal,
          })),
        displayedId = lookup.displayedId;
      {
        privateChatProof = await this.#navigation.prepareSharedSearch(
          job,
          displayedId,
          initial,
          voicePreparation,
          lookup.searchKind,
          uiaNavigation,
          lookup,
        );
        if (privateChatProof.editorFocused) {
          uiaReadyFrame = this.#frames.frame;
          continuationFingerprint = structuredClone(privateChatProof.uiaConversationFingerprint);
        } else if (!voicePreparation)
          await this.#input.sharedAction(
            'click',
            {
              rect: this.#frames.config.layout.editor,
            },
            ['header', 'editor'],
            this.#frames.frame,
          );
      }
    }
    const verified = {
      draft: previous?.jobId === job.id && continuation ? previous.draft : '',
      frame:
        (uiaReadyFrame === this.#frames.frame && uiaReadyFrame) ||
        (voicePreparation && voicePreparation.readyFrame === this.#frames.frame)
          ? this.#frames.frame
          : await this.#frames.capture(['header', 'editor']),
      draftPolicy: 'unchecked',
    };
    if (voicePreparation) {
      voicePreparation.start(verified.frame);
      const settled = await voicePreparation.pending;
      if (settled.error) throw settled.error;
      const proof = settled.proof;
      if (
        proof?.accountRef !== this.#frames.config.accountRef ||
        proof.accountScopeHash !== this.#frames.config.accountRef
      )
        throw fault('UI_QT_ACCOUNT_UNVERIFIED');
      validateAccountEvidence(proof.evidence, verified.frame.binding, this.#input.now());
      this.#input.active();
      this.#frames.assertTransaction(verified.frame);
      voicePreparation.proof = proof;
    }
    await this.#input.verifyControlBinding(job, verified.frame, 'prepare', signal);

    return {
      verified,
      privateChatProof,
      continuationFingerprint,
      recovering,
      fileTitleSha256: targetLookup?.fileTitleSha256,
    };
  }
}
