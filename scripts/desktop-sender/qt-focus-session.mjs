import {
  fault,
  incompleteForegroundInterval,
  object,
  observedLayout,
  sameRect,
  validFocusActivation,
  validFocusHandoff,
  validForegroundSession,
  validForegroundSessionRelease,
} from './qt-contract.mjs';
import { validateAccountEvidence } from './account-probe.mjs';
import { sanitizeForegroundIntervals, recordForegroundTiming, makeForegroundTiming } from './foreground-timing.mjs';
import { focusReturnDiagnostics, focusRestoreOutcomeDiagnostic } from './qt-diagnostics.mjs';

export class QtFocusSession {
  #root;
  #frames;
  #native;
  #active;
  #wait;
  #onTextRelease;
  #invalidateNavigation;
  constructor({ root, frames, native, active, wait, onTextRelease, invalidateNavigation }) {
    this.#root = root;
    this.#frames = frames;
    this.#native = native;
    this.#active = active;
    this.#wait = wait;
    this.#onTextRelease = onTextRelease;
    this.#invalidateNavigation = invalidateNavigation;
  }
  #textFocusLease;
  get textFocusLease() {
    return this.#textFocusLease;
  }
  #textFocusRelease;
  get textFocusRelease() {
    return this.#textFocusRelease;
  }
  #voiceFocusLease;
  get voiceFocusLease() {
    return this.#voiceFocusLease;
  }
  #foregroundIntervals;
  get foregroundIntervals() {
    return this.#foregroundIntervals;
  }
  #foregroundIntervalsInvalid;
  get foregroundIntervalsInvalid() {
    return this.#foregroundIntervalsInvalid;
  }
  async inspectFocusHandoff(owner = this.#native.owner) {
    if (owner !== this.#native.owner) throw fault('UI_QT_CLIENT_CHANGED', { attempted: false });
    const preflight = await this.#native.request('inspectFocusHandoff', {
      idleMs: this.#frames.config.idleMs,
      width: this.#frames.config.layout.width,
      height: this.#frames.config.layout.height,
      dpi: this.#frames.config.layout.dpi,
    });
    if (
      !object(preflight) ||
      typeof preflight.ready !== 'boolean' ||
      preflight.inputSent !== false ||
      preflight.clipboardAccessed !== false ||
      preflight.focusChanged !== false ||
      (preflight.ready && preflight.reason !== null) ||
      (!preflight.ready && !/^(?:QT_|DRAFT_)[A-Z0-9_]{1,80}$/.test(preflight.reason ?? ''))
    )
      throw fault('UI_QT_FOCUS_PREFLIGHT_INVALID');
    this.#active();
    return preflight;
  }
  resetForegroundIntervals() {
    this.#foregroundIntervals = [];
    this.#foregroundIntervalsInvalid = false;
  }
  beginVoiceLease(owner, handoff) {
    this.#voiceFocusLease = {
      owner,
      handoff: structuredClone(handoff),
      uiaMode: this.#frames.config.layoutMode === 'uia-v1',
      uiaInitialHeaderPending: true,
    };
    this.resetForegroundIntervals();
  }
  clearVoiceLease(owner) {
    if (this.#voiceFocusLease?.owner === owner) this.#voiceFocusLease = null;
  }
  async acquireForPreparation(job, preparation, { warmLocators, freshAccount, resumableTextStep, now }) {
    const { previous, voicePreparation, signal, borrowedFocus } = preparation;
    if (!this.textFocusLease) {
      if (this.textFocusRelease) await this.textFocusRelease;
      const owner = this.#native.owner;
      const preflight = await this.inspectFocusHandoff(owner);
      const inPlace =
        preflight.reason === 'QT_FOCUS_RETURN_WINDOW_REQUIRED' &&
        this.#frames.config.layoutMode === 'uia-v1' &&
        !voicePreparation &&
        job.mode !== 'voice';
      if (preflight.ready || inPlace) {
        if (!voicePreparation && !resumableTextStep(previous, job)) {
          // Process/database inspection does not need foreground. Bind this
          // one preparation to its current geometry, then validate its
          // unchanged 500ms evidence window again after acquiring focus.
          const inspection = await this.#native.request('inspectLayout', undefined, owner),
            binding = inspection?.binding,
            l = this.#frames.config.layout;
          if (
            inspection?.readOnly !== true ||
            inspection.inputSent !== false ||
            inspection.focusChanged !== false ||
            inspection.clipboardAccessed !== false ||
            inspection.executableVersion !== this.#frames.config.executableVersion ||
            inspection.executableSha256 !== this.#frames.config.executableSha256 ||
            !object(binding) ||
            !sameRect(binding.clientRect, {
              left: 0,
              top: 0,
              right: l.width,
              bottom: l.height,
            }) ||
            binding.dpi !== l.dpi ||
            !object(binding.captureRect) ||
            !['left', 'top', 'right', 'bottom'].every(key => Number.isSafeInteger(binding.captureRect[key])) ||
            binding.captureRect.right - binding.captureRect.left !== l.width ||
            binding.captureRect.bottom - binding.captureRect.top !== l.height
          )
            throw fault('QT_BINDING_CHANGED');
          const observed = structuredClone(binding);
          let proof;
          await warmLocators({
            owner,
            inspection,
            signal,
          });
          try {
            proof = await freshAccount({
              frame: {
                binding: observed,
              },
              park: false,
            });
            validateAccountEvidence(proof.evidence, observed, now());
          } catch (error) {
            // This exact read-only call precedes focus acquisition and all
            // navigation/input. A same-code failure elsewhere has no proof.
            if (
              !borrowedFocus &&
              !this.preparationLease() &&
              !voicePreparation &&
              !signal?.aborted &&
              /^(?:UI_ACCOUNT_[A-Z_]+|UI_QT_ACCOUNT_UNVERIFIED)$/.test(error?.code ?? '') &&
              error.code !== 'UI_ACCOUNT_PROBE_ABORTED'
            )
              preparation.backgroundAccountFailure = error;
            throw error;
          }
          this.#active();
          preparation.backgroundAccount = {
            binding: observed,
            proof,
          };
        }
        let acquired;
        try {
          acquired = await this.#native.request(
            inPlace ? 'beginForegroundSession' : 'beginFocusHandoff',
            {
              idleMs: this.#frames.config.idleMs,
              width: this.#frames.config.layout.width,
              height: this.#frames.config.layout.height,
              dpi: this.#frames.config.layout.dpi,
              ...(inPlace
                ? {
                    uiaMode: true,
                  }
                : {
                    includesContactNavigation: observedLayout(this.#frames.config) && !resumableTextStep(previous, job),
                    ...this.focusActivation(),
                  }),
            },
            owner,
          );
        } catch (error) {
          // These two codes originate while probing the return caption,
          // before the native focus lease is created or WeChat is activated.
          if (
            error.attempted === false &&
            ['QT_RETURN_CAPTION_UNAVAILABLE', 'QT_RETURN_CAPTION_WARMUP'].includes(error.code)
          )
            preparation.returnCaptionFailure = error;
          throw error;
        }
        if (
          inPlace
            ? !validForegroundSession(acquired)
            : acquired?.activated !== true || !validFocusHandoff(acquired.focusHandoff)
        )
          throw fault('UI_QT_FOCUS_LEASE_INVALID');
        this.beginTextLease(owner, acquired, { inPlace, initialHeader: true });
        preparation.borrowedFocus = !inPlace;
        preparation.unborrowedForeground = inPlace;
      } else if (preflight.reason !== 'QT_FOCUS_RETURN_WINDOW_REQUIRED') {
        const error = fault(preflight.reason, {
          attempted: false,
        });
        if (['QT_RETURN_CAPTION_UNAVAILABLE', 'QT_RETURN_CAPTION_WARMUP'].includes(preflight.reason))
          preparation.returnCaptionFailure = error;
        throw error;
      }
    }
  }
  beginTextLease(owner, acquired, { inPlace, initialHeader = false }) {
    this.#textFocusLease = {
      owner,
      ...(inPlace
        ? { inPlace: true, sessionId: acquired.sessionId }
        : { handoff: structuredClone(acquired.focusHandoff) }),
      ...(initialHeader ? { uiaInitialHeaderPending: true } : {}),
      uiaMode: this.#frames.config.layoutMode === 'uia-v1',
    };
    this.#textFocusRelease = null;
    this.resetForegroundIntervals();
  }
  focusActivation() {
    if (this.#frames.config.layoutMode === 'uia-v1')
      return {
        uiaCaptionActivation: true,
      };
    const l = this.#frames.config.layout;
    if (l.focusActivateRect)
      return {
        focusActivation: {
          rect: l.focusActivateRect,
          rgbaSha256: l.focusActivateRgbaSha256,
        },
      };
    const activation = {
      rect: l.pointerParkRect,
      mode: 'blank-caption-v1',
    };
    // Adaptive layouts already locate this blank caption patch. The native
    // fallback raises the bound window without focus, observes its current
    // inactive pixels, then clicks once; no inactive manual calibration.
    return observedLayout(this.#frames.config) && validFocusActivation(activation, l.width)
      ? {
          focusActivation: activation,
        }
      : {};
  }
  preparationLease() {
    return this.#voiceFocusLease ?? this.#textFocusLease;
  }
  addForegroundInterval(interval) {
    const values = sanitizeForegroundIntervals([interval], {
      phases: ['contact-navigation', 'preparation'],
      maxCount: 1,
    });
    if (!values) {
      this.#foregroundIntervalsInvalid = true;
      return;
    }
    this.#foregroundIntervals ??= [];
    this.#foregroundIntervals.push(...values);
    if (this.#foregroundIntervals.length > 30) this.#foregroundIntervalsInvalid = true;
  }
  completedForegroundIntervals() {
    return this.#foregroundIntervalsInvalid
      ? undefined
      : sanitizeForegroundIntervals(this.#foregroundIntervals ?? [], {
          phases: ['contact-navigation', 'preparation'],
          maxCount: 30,
        });
  }
  async withPreparationFocusParked(task, { includesContactNavigation = false } = {}) {
    const lease = this.preparationLease();
    if (!lease) return task();
    if (lease.inPlace) {
      this.#active();
      const value = await task();
      this.#active();
      if (this.preparationLease() !== lease || lease.parked) throw fault('UI_QT_FOCUS_SEGMENT_INVALID');
      return value;
    }
    if (lease.parked || this.#frames.surface !== 'main') throw fault('UI_QT_FOCUS_SEGMENT_INVALID');
    const checkpoint = await this.#frames.capture(['header']);
    this.#active();
    const parked = await this.#native.request('parkFocusHandoff', undefined, lease.owner);
    if (parked?.parked !== true || parked.restored !== true || parked.skipped !== false)
      throw fault('UI_QT_FOCUS_RETURN_UNCONFIRMED', focusReturnDiagnostics(parked));
    lease.parked = true;
    this.#frames.invalidateFrame();
    this.addForegroundInterval(parked.foregroundInterval);
    // Do not reacquire focus when background work fails or is cancelled. Native
    // release/stop can retire a parked lease without another foreground action.
    // A real usable return interval, even when the background task is empty or
    // cached. Work overlaps the minimum gap; native still rejects any human
    // activity during it instead of immediately borrowing focus back.
    const [value] = await Promise.all([task(), this.#wait(250)]);
    this.#active();
    const resumed = await this.#native.request(
      'resumeFocusHandoff',
      {
        includesContactNavigation,
      },
      lease.owner,
    );
    const uia = lease.uiaMode === true;
    if (
      resumed?.resumed !== true ||
      !validFocusHandoff(lease.handoff) ||
      !validFocusHandoff(resumed.focusHandoff) ||
      JSON.stringify(resumed.focusHandoff.returnWindow) !== JSON.stringify(lease.handoff.returnWindow) ||
      uia !== (this.#frames.config.layoutMode === 'uia-v1')
    )
      throw fault('UI_QT_FOCUS_LEASE_INVALID');
    if (uia) {
      if (
        [lease.handoff.activation, resumed.focusHandoff.activation].some(
          value => value !== undefined && value.mode !== 'uia-caption-v1',
        )
      )
        throw fault('UI_QT_FOCUS_LEASE_INVALID');
      lease.handoff = structuredClone(resumed.focusHandoff);
    } else if (JSON.stringify(resumed.focusHandoff.activation) !== JSON.stringify(lease.handoff.activation))
      throw fault('UI_QT_FOCUS_LEASE_INVALID');
    lease.parked = false;
    this.#frames.invalidateFrame();
    // Keep the original transaction. The next capture must still match its
    // epoch/revision/process; activity while parked is never silently accepted.
    const current = await this.#frames.capture(['header']);
    if (current.regions[0]?.rgbaSha256 !== checkpoint.regions[0]?.rgbaSha256) throw fault('UI_QT_HEADER_CHANGED');
    return value;
  }
  #recordTiming() {
    const intervals = this.completedForegroundIntervals();
    if (intervals?.length)
      recordForegroundTiming({
        root: this.#root,
        timing: makeForegroundTiming({ operation: 'text', preparationIntervals: intervals }),
      });
    return intervals;
  }
  releaseTextFocus() {
    this.#frames.restoreEditor();
    if (!this.#textFocusLease)
      return (
        this.#textFocusRelease ??
        Promise.resolve({
          released: false,
          restored: false,
          skipped: true,
        })
      );
    const { owner, parked, inPlace, sessionId } = this.#textFocusLease;
    this.#textFocusLease = null;
    // Keep the completed-input checkpoint for an explicit same-job resume;
    // observation remains blocked until the original window is reacquired.
    this.#onTextRelease();
    this.#frames.clearTransaction();
    this.#frames.invalidateFrame('main');
    return (this.#textFocusRelease = (async () => {
      try {
        const result = await this.#native.releaseFocus(owner);
        if (inPlace) {
          if (!validForegroundSessionRelease(result, sessionId)) throw fault('UI_QT_FOCUS_LEASE_INVALID');
          if (!result.identitiesUnchanged || !result.foregroundOwnedByWechat || !result.activityUnchanged)
            this.#invalidateNavigation();
          return {
            released: true,
            inPlace: true,
            restored: false,
            skipped: true,
          };
        }
        if (result?.restored !== true || result?.skipped === true) this.#invalidateNavigation();
        if (result?.restored !== true && result?.skipped !== true)
          throw fault('UI_QT_FOCUS_RETURN_UNCONFIRMED', focusReturnDiagnostics(result));
        if (result.foregroundInterval !== undefined)
          this.addForegroundInterval(
            result.restored === true && result.skipped !== true
              ? result.foregroundInterval
              : incompleteForegroundInterval(result.foregroundInterval),
          );
        else if (!parked) this.#foregroundIntervalsInvalid = true;
        const foregroundIntervals = this.#recordTiming();
        const focusRestoreOutcome = focusRestoreOutcomeDiagnostic(result.focusRestoreOutcome);
        return {
          released: true,
          restored: result.restored === true,
          skipped: result.skipped === true,
          ...(foregroundIntervals
            ? {
                foregroundIntervals,
              }
            : {}),
          ...(focusRestoreOutcome
            ? {
                focusRestoreOutcome,
              }
            : {}),
        };
      } catch (error) {
        // A failed cleanup is still a failed cleanup. Its measured prefix must
        // replace the previous complete timing, without claiming we observed
        // the end of focus ownership or authorizing another input attempt.
        this.#invalidateNavigation();
        if (error?.foregroundInterval !== undefined)
          this.addForegroundInterval(incompleteForegroundInterval(error.foregroundInterval));
        else this.#foregroundIntervalsInvalid = true;
        const foregroundIntervals = this.#recordTiming();
        try {
          await this.#native.close(owner);
        } catch {}
        throw fault('UI_QT_FOCUS_RETURN_UNCONFIRMED', {
          ...focusReturnDiagnostics(error),
          ...(foregroundIntervals
            ? {
                foregroundIntervals,
              }
            : {}),
        });
      }
    })());
  }
}
