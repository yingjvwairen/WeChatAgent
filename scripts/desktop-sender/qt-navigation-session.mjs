import {
  alias,
  fault,
  hash,
  inside,
  navigationTransitionFailure,
  object,
  observedLayout,
  positiveDecimal,
  rect,
  sameRect,
  toObservedPopupCalibration,
  uiaTargetEvidence,
  validConversationFingerprint,
} from './qt-contract.mjs';
import crypto from 'node:crypto';
import { clipboardOutcome, pixelMismatchDiagnostic } from './qt-diagnostics.mjs';
import { isDeepStrictEqual } from 'node:util';

const digest = text => crypto.createHash('sha256').update(text).digest('hex');

// Navigation owns search observations; the driver owns the active surface and input session.
class QtNavigationSession {
  #uiaWarmHint = null;
  /** @type {ReturnType<typeof import('./qt-session-access.mjs').navigationAccess>} */
  #input;
  #frames;
  #focus;
  constructor({ input, frames, focus }) {
    this.#input = input;
    this.#frames = frames;
    this.#focus = focus;
  }
  async lookupTarget(job, { signal } = {}) {
    this.#input.checkJob(job);
    if (signal?.aborted) throw fault('UI_QT_CANCELLED');
    const account = job.account,
      target = job.target,
      accountRef = this.#frames.config.accountRef;
    const contact = await this.#input.resolveTarget(job, {
      signal,
    });
    this.#input.checkJob(job);
    if (job.account !== account || job.target !== target || this.#frames.config.accountRef !== accountRef)
      throw fault('UI_QT_TARGET_CHANGED');
    const group = target.endsWith('@chatroom');
    if (!object(contact) || contact.wechatId !== target || contact.ambiguous !== false)
      throw fault(group ? 'UI_QT_GROUP_SEARCH_NAME_REQUIRED' : 'UI_QT_TARGET_ALIAS_REQUIRED');
    const title = contact.name;
    const validName = value =>
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 128 &&
      value.trim() === value &&
      value.isWellFormed() &&
      !/[\u0000-\u001f\u007f]/u.test(value) &&
      !value.endsWith('@chatroom');
    const publicId = !group && alias(contact.alias) ? contact.alias : null;
    const query = publicId || contact.searchName;
    if (!publicId && (!observedLayout(this.#frames.config) || !contact.uniqueSearchName || !validName(query)))
      throw fault(group ? 'UI_QT_GROUP_SEARCH_NAME_REQUIRED' : 'UI_QT_TARGET_SEARCH_NAME_REQUIRED');
    if (group && (contact.kind !== 'group' || contact.groupName !== title || query !== title || !contact.uniqueTitle))
      throw fault('UI_QT_GROUP_SEARCH_NAME_REQUIRED');
    const lookup = {
      account,
      target,
      accountRef,
      displayedId: query,
      ...(job.mode === 'file' && validName(title) ? { fileTitleSha256: digest(title) } : {}),
      ...(publicId
        ? {}
        : {
            searchKind: group ? 'group-title' : 'private-name',
          }),
    };
    if (this.#frames.config.layoutMode === 'uia-v1') {
      if (!validName(title)) throw fault('UI_QT_TARGET_SEARCH_NAME_REQUIRED');
      // Only a unique title permits reusing the open chat. A unique nickname
      // can navigate to its owner even when several chats display that remark.
      lookup.uiaTarget = Object.freeze({
        version: 1,
        proof: contact.uniqueTitle === true ? 'database-unique-display-name-v1' : 'database-exact-search-v1',
        titleSha256: digest(title),
        querySha256: digest(query),
      });
    } else if (this.#frames.config.layoutMode === 'adaptive-v1' && contact.uniqueTitle === true && validName(title))
      lookup.currentTitleSha256 = digest(title);
    return Object.freeze(lookup);
  }
  async currentOcrChat(job, baseline, lookup) {
    if (this.#frames.config.layoutMode !== 'adaptive-v1' || !hash(lookup?.currentTitleSha256)) return null;
    if (
      lookup.account !== job.account ||
      lookup.target !== job.target ||
      lookup.accountRef !== this.#frames.config.accountRef
    )
      throw fault('UI_QT_TARGET_CHANGED');
    this.#frames.assertTransaction(baseline);
    const { token, epoch, revision } = baseline;
    const result = await this.#input.requestNative('verifyOpenChatTitle', {
      token,
      epoch,
      revision,
      idleMs: this.#frames.config.idleMs,
      titleSha256: lookup.currentTitleSha256,
    });
    this.#frames.assertTransaction(baseline);
    if (typeof result?.matches !== 'boolean') throw fault('UI_QT_TARGET_CHANGED');
    if (!result.matches) return null;
    return Object.freeze({
      kind: 'uia-database-title-v1',
      account: job.account,
      target: job.target,
      querySha256: digest(lookup.displayedId),
      titleSha256: lookup.currentTitleSha256,
      header: this.#frames.regionDigest(baseline, 0),
      searchKind: lookup.searchKind,
    });
  }
  popupTransition(surface) {
    const calibration = this.#frames.popupCalibration(surface),
      adaptive = observedLayout(this.#frames.config);
    this.#frames.invalidatePopupGeometry(surface);
    return calibration
      ? {
          popupTransition: {
            id: surface,
            calibration: adaptive
              ? toObservedPopupCalibration(calibration, surface === 'search' ? 'search' : 'profile')
              : calibration,
            ...(adaptive
              ? {
                  geometryMode: 'observed-v1',
                }
              : {}),
          },
        }
      : {};
  }
  uiaNavigationElapsed(context) {
    return Math.max(this.#input.now() - context.started, context.waited);
  }
  assertUiaInitialHeader(context, frame) {
    this.#input.active();
    if (this.#focus.preparationLease() !== context.lease || context.lease.parked || this.#frames.surface !== 'main')
      throw fault('UI_QT_OBSERVATION_CHANGED');
    if (this.uiaNavigationElapsed(context) > 400) throw fault('UI_QT_INITIAL_HEADER_UNSTABLE');
    if (!frame) return;
    if (frame.idleMs < this.#frames.config.idleMs) throw fault('UI_USER_ACTIVE');
    if (
      frame.popup ||
      frame.regions.length !== 1 ||
      !sameRect(frame.regions[0].rect, this.#frames.config.layout.header)
    )
      throw fault('UI_QT_OBSERVATION_CHANGED');
    const baseline = context.baseline;
    if (
      baseline &&
      (frame.epoch !== baseline.epoch ||
        frame.revision !== baseline.revision ||
        !['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi', 'lastInputTick', 'focusHwnd'].every(
          key => frame.binding[key] === baseline.binding[key],
        ) ||
        !['clientRect', 'captureRect'].every(key => sameRect(frame.binding[key], baseline.binding[key])))
    )
      throw fault('UI_QT_OBSERVATION_CHANGED');
    context.baseline ??= structuredClone(frame);
  }
  async waitUiaInitialHeader(context) {
    this.assertUiaInitialHeader(context);
    if (this.uiaNavigationElapsed(context) + 35 > 400) throw fault('UI_QT_INITIAL_HEADER_UNSTABLE');
    await this.#input.wait(35);
    context.waited += 35;
    this.assertUiaInitialHeader(context);
  }
  async stableUiaInitialHeader(
    lease,
    {
      context = {
        lease,
        started: this.#input.now(),
        waited: 0,
      },
      firstOnly = false,
    } = {},
  ) {
    let previous,
      backoff = false;
    for (let index = 0; index < 25; index++) {
      if (backoff) {
        await this.waitUiaInitialHeader(context);
        backoff = false;
      }
      this.assertUiaInitialHeader(context);
      let frame;
      try {
        frame = await this.#frames.capture(['header'], false, {
          retryPixelChanges: false,
        });
      } catch (error) {
        const mismatch = pixelMismatchDiagnostic(error?.pixelMismatch);
        if (
          error?.code !== 'QT_PIXELS_CHANGED' ||
          error.attempted !== false ||
          mismatch?.stage !== 'capture' ||
          mismatch.anchorIndex !== 0
        )
          throw error;
        previous = null;
        backoff = true;
        continue;
      }
      this.assertUiaInitialHeader(context, frame);
      // Native capture already compares two pixel reads. Fresh navigation can
      // consume its first valid token; only a rejected cached-chat candidate
      // retains the conservative consecutive-observation fallback.
      if (firstOnly || previous === frame.regions[0].rgbaSha256) return frame;
      // Stable controls incur no scheduled delay. Only observed redraw gets a
      // bounded read-only backoff; the subsequent native input guard is intact.
      if (previous !== undefined && previous !== null) backoff = true;
      previous = frame.regions[0].rgbaSha256;
    }
    throw fault('UI_QT_INITIAL_HEADER_UNSTABLE');
  }
  async openUiaSearch(frame, context) {
    if (frame.navigationOnly === true) {
      this.assertUiaInitialHeader(context, frame);
      await context.validateAccount?.(frame);
      this.assertUiaInitialHeader(context, frame);
      const result = await this.#input.sharedAction('openUiaSearch', this.popupTransition('search'), ['header'], frame);
      if (result.openedSearch !== true || result.navigationOnly !== true || result.baselinePixelStable !== false)
        throw fault('UI_QT_SEARCH_ENTER_UNCERTAIN');
      return frame;
    }
    for (;;) {
      this.assertUiaInitialHeader(context, frame);
      await context.validateAccount?.(frame);
      this.assertUiaInitialHeader(context, frame);
      try {
        await this.#input.sharedAction(
          'chord',
          {
            key: 'Control+F',
            ...this.popupTransition('search'),
          },
          ['header'],
          frame,
        );
        // This exact frame is the transition baseline, including any redraw
        // observed before the first successfully executed navigation input.
        return frame;
      } catch (error) {
        const mismatch = pixelMismatchDiagnostic(error?.pixelMismatch);
        if (
          error?.code !== 'QT_PIXELS_CHANGED' ||
          error.attempted !== false ||
          mismatch?.stage !== 'guard' ||
          mismatch.anchorIndex !== 0
        )
          throw error;
        // QtGuard rejected the header before preparing a popup or calling
        // SendInput. No other input, ambiguous result or resume may repeat.
        await this.waitUiaInitialHeader(context);
        frame = await this.stableUiaInitialHeader(context.lease, {
          context,
          firstOnly: true,
        });
      }
    }
  }
  async stableSelfOpenFrame() {
    this.#input.active();
    const baseline = structuredClone(this.#frames.frame),
      layout = this.#frames.config.layout;
    if (this.#frames.surface !== 'main' || !this.#frames.transaction) throw fault('UI_QT_OBSERVATION_INVALID');
    this.#frames.assertTransaction(baseline);
    const header = baseline.regions.find(region => sameRect(region.rect, layout.header));
    if (!header) throw fault('UI_QT_OBSERVATION_INVALID');
    const started = this.#input.now();
    let previous,
      waited = 0,
      lastMismatch;
    const elapsed = () => Math.max(this.#input.now() - started, waited);
    // Focus activation can redraw the avatar after a successful screenshot.
    // Observe the complete calibrated header and avatar twice, retaining the
    // original transaction and header. Only failed read-only avatar captures
    // may repeat; the returned token is consumed by exactly one input attempt.
    for (let attempt = 0; attempt < 12; attempt++) {
      if (attempt > 0) {
        if (elapsed() + 35 > 400) break;
        await this.#input.wait(35);
        waited += 35;
        this.#input.active();
      }
      if (elapsed() > 400) break;
      let current;
      try {
        current = await this.#frames.capture(['header', 'selfOpen'], false, {
          retryPixelChanges: false,
        });
      } catch (error) {
        const mismatch = pixelMismatchDiagnostic(error?.pixelMismatch);
        if (
          error?.code !== 'QT_PIXELS_CHANGED' ||
          error.attempted !== false ||
          mismatch?.stage !== 'capture' ||
          mismatch?.anchorIndex !== 1
        )
          throw error;
        previous = null;
        lastMismatch = error;
        continue;
      }
      if (current.idleMs < this.#frames.config.idleMs) throw fault('UI_USER_ACTIVE');
      if (
        current.binding.hwnd !== baseline.binding.hwnd ||
        current.binding.dpi !== baseline.binding.dpi ||
        !sameRect(current.binding.clientRect, baseline.binding.clientRect) ||
        !sameRect(current.binding.captureRect, baseline.binding.captureRect)
      )
        throw fault('UI_QT_OBSERVATION_CHANGED');
      if (
        current.regions.length !== 2 ||
        !sameRect(current.regions[0].rect, layout.header) ||
        !sameRect(current.regions[1].rect, layout.selfOpen)
      )
        throw fault('UI_QT_OBSERVATION_INVALID');
      if (current.regions[0].rgbaSha256 !== header.rgbaSha256) throw fault('UI_QT_HEADER_CHANGED');
      if (elapsed() > 400) break;
      if (previous && current.regions[1].rgbaSha256 === previous.regions[1].rgbaSha256) return current;
      previous = current;
    }
    throw (
      lastMismatch ??
      fault('QT_PIXELS_CHANGED', {
        attempted: false,
        pixelMismatch: {
          stage: 'capture',
          anchorIndex: 1,
        },
      })
    );
  }
  async settleSearchQueryClick(baseline) {
    this.#input.active();
    const query = this.#frames.config.layout.search,
      lease = this.#focus.preparationLease(),
      popup = baseline?.popup;
    if (
      !observedLayout(this.#frames.config) ||
      this.#frames.surface !== 'search' ||
      !lease ||
      lease.parked ||
      !this.#frames.transaction ||
      popup?.surfaceId !== 'search' ||
      popup.kind !== 'search' ||
      baseline.regions?.length !== 1 ||
      !sameRect(baseline.regions[0].rect, query) ||
      query.left < popup.clientRectInRoot.left ||
      query.right > popup.clientRectInRoot.right ||
      query.top + (query.bottom - query.top) / 2 >= popup.clientRectInRoot.top
    )
      throw fault('UI_QT_OBSERVATION_INVALID');
    this.#frames.assertTransaction(baseline);
    const started = this.#input.now(),
      settle = this.#frames.config.settleMs ?? 400,
      observeFor = Math.min(settle, 250);
    let waited = 0,
      previous;
    const elapsed = () => Math.max(this.#input.now() - started, waited);
    const caretReady = frame => {
      const binding = frame.binding,
        caret = binding.caretRectInClient;
      return (
        Number.isSafeInteger(binding.threadId) &&
        binding.threadId > 0 &&
        binding.focusHwnd === binding.hwnd &&
        binding.caretHwnd === binding.hwnd &&
        binding.focusBelongsToWindow === true &&
        binding.caretBelongsToWindow === true &&
        binding.guiFlags === 1 &&
        rect(caret) &&
        Object.keys(caret).length === 4 &&
        inside(query, caret) &&
        caret.bottom <= frame.popup.clientRectInRoot.top
      );
    };
    // The real click retains the native one-use QueryClickProof. These reads
    // only qualify a shorter wait; paste still obtains a new native guard.
    for (let index = 0; index < 8; index++) {
      if (index) {
        if (elapsed() + 35 > observeFor) break;
        await this.#input.wait(35);
        waited += 35;
      }
      this.#input.active();
      if (this.#frames.surface !== 'search' || this.#focus.preparationLease() !== lease || lease.parked)
        throw fault('UI_QT_OBSERVATION_CHANGED');
      if (elapsed() >= observeFor) break;
      let current;
      try {
        current = await this.#frames.capture(['search'], false, {
          retryPixelChanges: false,
        });
      } catch (error) {
        const mismatch = pixelMismatchDiagnostic(error?.pixelMismatch);
        if (
          error?.code !== 'QT_PIXELS_CHANGED' ||
          error.attempted !== false ||
          mismatch?.stage !== 'capture' ||
          mismatch.anchorIndex !== 0
        )
          throw error;
        previous = null;
        continue;
      }
      if (current.idleMs < this.#frames.config.idleMs) throw fault('UI_USER_ACTIVE');
      if (
        !['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi', 'focusHwnd'].every(
          key => current.binding[key] === baseline.binding[key],
        ) ||
        current.binding.focusBelongsToWindow === false ||
        !['clientRect', 'captureRect'].every(key => sameRect(current.binding[key], baseline.binding[key])) ||
        current.epoch !== baseline.epoch ||
        current.revision !== baseline.revision ||
        !['hwnd', 'kind', 'surfaceId', 'ownerRelation', 'geometryMode', 'dpi', 'stableObservations'].every(
          key => current.popup[key] === popup[key],
        ) ||
        !['clientRect', 'clientRectInRoot', 'windowRect'].every(key => sameRect(current.popup[key], popup[key]))
      )
        throw fault('UI_QT_OBSERVATION_CHANGED');
      if (current.regions.length !== 1 || !sameRect(current.regions[0].rect, query))
        throw fault('UI_QT_OBSERVATION_INVALID');
      if (elapsed() > observeFor) break;
      if (
        caretReady(current) &&
        previous &&
        caretReady(previous) &&
        sameRect(current.binding.caretRectInClient, previous.binding.caretRectInClient) &&
        current.regions[0].rgbaSha256 === previous.regions[0].rgbaSha256
      )
        return;
      previous = caretReady(current) ? current : null;
    }
    // Missing caret metadata never authorizes the shortcut. Keep the original
    // remaining settle delay, without another click or any input retry.
    const remaining = settle - elapsed();
    if (remaining > 0) await this.#input.wait(remaining);
    this.#input.active();
  }
  async closeObservedSearch(baseline) {
    this.#input.active();
    if (
      !observedLayout(this.#frames.config) ||
      this.#frames.surface !== 'search' ||
      !this.#focus.preparationLease() ||
      !this.#frames.transaction
    )
      throw fault('UI_QT_OBSERVATION_INVALID');
    const layout = this.#frames.config.layout,
      anchor = layout.header ?? layout.search,
      mainAnchor = baseline?.regions?.find(entry => sameRect(entry.rect, anchor));
    if (
      !mainAnchor ||
      !hash(mainAnchor.rgbaSha256) ||
      baseline.epoch !== this.#frames.transaction.epoch ||
      baseline.revision !== this.#frames.transaction.revision ||
      baseline.binding?.pid !== this.#frames.transaction.pid ||
      baseline.binding?.processCreatedFileTimeUtc !== this.#frames.transaction.created ||
      baseline.binding?.clientRect?.right !== layout.width ||
      baseline.binding?.clientRect?.bottom !== layout.height
    )
      throw fault('UI_QT_OBSERVATION_INVALID');
    const popup = await this.#frames.capture(['searchResultIdentity'], false, { retryPixelChanges: false });
    this.#input.active();
    this.#frames.assertTransaction(popup);
    let result;
    try {
      result = await this.#input.requestNative('chord', {
        key: 'Escape',
        token: popup.token,
        epoch: popup.epoch,
        revision: popup.revision,
        idleMs: this.#frames.config.idleMs,
      });
    } finally {
      this.#frames.invalidateFrame('main');
    }
    if (result.revision !== this.#frames.transaction.revision) throw fault('UI_QT_HUMAN_ACTIVITY_CHANGED');
    if (result.performed !== true || result.attempted !== true) throw fault('UI_QT_SEARCH_CLOSE_UNVERIFIED');
    return this.observeMainAfterSearchEscape(baseline);
  }
  async observeMainAfterSearchEscape(baseline) {
    const layout = this.#frames.config.layout,
      names = layout.header ? ['header', 'editor'] : ['search'],
      mainAnchor = baseline.regions.find(entry => sameRect(entry.rect, layout[names[0]]));
    // The successful key reply is not completion evidence. Two fresh native
    // main-window observations replace only the old fixed post-Escape wait.
    // Full header/editor pixels, original identity/geometry and activity stay
    // guarded. Escape can return before main-window activation is delivered.
    // Only that failed read-only observation may repeat; no input is repeated
    // and no new activity epoch is accepted while awaiting the original main.
    const started = this.#input.now();
    let previous,
      waited = 0,
      lastFocusFailure;
    const elapsed = () => Math.max(this.#input.now() - started, waited);
    for (let index = 0; index < 12; index++) {
      if (index) {
        if (elapsed() + 35 > 400) break;
        await this.#input.wait(35);
        waited += 35;
      }
      this.#input.active();
      if (elapsed() > 400) break;
      let current;
      try {
        current = await this.#frames.capture(names, false, {
          retryPixelChanges: false,
        });
      } catch (error) {
        // Search Escape can complete before its visible popup has left the
        // desktop. A refused read grants nothing: repeat the native full
        // visibility check, never ignore an overlap or send another Escape.
        if (
          error.attempted !== false ||
          (error.code !== 'DRAFT_WINDOW_NOT_FOREGROUND' && error.code !== 'QT_WINDOW_OBSCURED')
        )
          throw error;
        lastFocusFailure = error;
        previous = null;
        continue;
      }
      if (elapsed() > 400) break;
      if (current.idleMs < this.#frames.config.idleMs) throw fault('UI_USER_ACTIVE');
      if (
        current.binding.hwnd !== baseline.binding.hwnd ||
        current.binding.dpi !== baseline.binding.dpi ||
        current.binding.threadId !== baseline.binding.threadId ||
        !sameRect(current.binding.clientRect, baseline.binding.clientRect) ||
        !sameRect(current.binding.captureRect, baseline.binding.captureRect)
      )
        throw fault('UI_QT_OBSERVATION_CHANGED');
      if (
        current.regions.length !== names.length ||
        !current.regions.every((entry, index) => sameRect(entry.rect, layout[names[index]]))
      )
        throw fault('UI_QT_OBSERVATION_INVALID');
      if (current.regions[0].rgbaSha256 !== mainAnchor.rgbaSha256) throw fault('UI_QT_HEADER_CHANGED');
      if (previous && current.regions.every((entry, index) => entry.rgbaSha256 === previous.regions[index].rgbaSha256))
        return current;
      previous = current;
    }
    throw lastFocusFailure ?? fault('UI_QT_SEARCH_CLOSE_UNVERIFIED');
  }
  async warmUiaLocators({ owner = this.#input.nativeOwner, inspection, signal = this.#input.operationSignal } = {}) {
    if (this.#frames.config.layoutMode !== 'uia-v1' || this.#frames.navigationPolicy !== 'uia-controls-v1') return;
    const active = () => {
      this.#input.active();
      if (signal?.aborted) throw fault('UI_QT_CANCELLED');
      if (owner !== this.#input.nativeOwner) throw fault('UI_QT_CONTROLS_BINDING_CHANGED');
    };
    active();
    const config = structuredClone(this.#frames.config),
      layout = config.layout;
    inspection ??= await this.#input.requestNative('inspectLayout', undefined, owner);
    active();
    const binding = inspection?.binding;
    if (
      inspection?.readOnly !== true ||
      inspection.inputSent !== false ||
      inspection.focusChanged !== false ||
      inspection.clipboardAccessed !== false ||
      inspection.executableVersion !== config.executableVersion ||
      inspection.executableSha256 !== config.executableSha256 ||
      !object(binding) ||
      !positiveDecimal(binding.hwnd) ||
      !positiveDecimal(binding.processCreatedFileTimeUtc) ||
      !Number.isSafeInteger(binding.pid) ||
      binding.pid <= 0 ||
      binding.pid > 0xffffffff ||
      typeof binding.foreground !== 'boolean' ||
      (config.hwnd !== 'auto' && binding.hwnd !== config.hwnd) ||
      binding.dpi !== layout.dpi ||
      !sameRect(binding.clientRect, {
        left: 0,
        top: 0,
        right: layout.width,
        bottom: layout.height,
      }) ||
      !object(binding.captureRect) ||
      !['left', 'top', 'right', 'bottom'].every(key => Number.isSafeInteger(binding.captureRect[key])) ||
      binding.captureRect.right - binding.captureRect.left !== layout.width ||
      binding.captureRect.bottom - binding.captureRect.top !== layout.height
    )
      throw fault('UI_QT_UIA_WARMUP_UNCONFIRMED');
    const keys = ['hwnd', 'pid', 'processCreatedFileTimeUtc', 'dpi', 'clientRect', 'captureRect'],
      expectedBinding = Object.fromEntries(keys.map(key => [key, structuredClone(binding[key])]));
    // This memo only avoids repeating cold-start work on the same host and
    // window. It never supplies an observation or skips live input checks.
    if (this.#uiaWarmHint?.owner === owner && isDeepStrictEqual(this.#uiaWarmHint.binding, expectedBinding)) return;
    const result = await this.#input.requestNative(
      'warmUiaLocators',
      {
        expectedBinding,
      },
      owner,
    );
    active();
    const fields = [
      'version',
      'warmed',
      'readOnly',
      'inputSent',
      'focusChanged',
      'clipboardAccessed',
      'authorizationGranted',
      'foregroundUnchanged',
      'inputTickUnchanged',
      'cursorUnchanged',
      'binding',
      'roles',
    ];
    if (
      !object(result) ||
      Object.keys(result).length !== fields.length ||
      Object.keys(result).some(key => !fields.includes(key)) ||
      result.version !== 1 ||
      result.warmed !== true ||
      result.readOnly !== true ||
      result.inputSent !== false ||
      result.focusChanged !== false ||
      result.clipboardAccessed !== false ||
      result.authorizationGranted !== false ||
      result.foregroundUnchanged !== true ||
      result.inputTickUnchanged !== true ||
      result.cursorUnchanged !== true ||
      !isDeepStrictEqual(result.roles, ['header', 'editor', 'send']) ||
      !object(result.binding) ||
      Object.keys(result.binding).length !== 7 ||
      Object.keys(result.binding).some(key => !keys.includes(key) && key !== 'foreground') ||
      typeof result.binding.foreground !== 'boolean' ||
      result.binding.foreground !== binding.foreground ||
      !keys.every(key => isDeepStrictEqual(result.binding[key], expectedBinding[key])) ||
      !isDeepStrictEqual(config, this.#frames.config)
    )
      throw fault('UI_QT_UIA_WARMUP_UNCONFIRMED');
    this.#uiaWarmHint = {
      owner,
      binding: structuredClone(expectedBinding),
    };
  }
  async uiaConversationReady(job, baseline, lookup, searchPopupHwnd = '0', { allowLayoutRefresh = false } = {}) {
    if (
      this.#frames.config.layoutMode !== 'uia-v1' ||
      !uiaTargetEvidence(lookup) ||
      lookup.account !== job.account ||
      lookup.target !== job.target ||
      lookup.accountRef !== this.#frames.config.accountRef ||
      (lookup.uiaTarget.proof === 'database-exact-search-v1' && searchPopupHwnd === '0')
    )
      throw fault('UI_QT_TARGET_CHANGED');
    const request = {
      version: 1,
      expectedTitleSha256: lookup.uiaTarget.titleSha256,
      expectedQuerySha256: lookup.uiaTarget.querySha256,
      searchPopupHwnd,
    };
    const proof = await this.#input.verifyControlBinding(
        job,
        baseline,
        'navigation-ready',
        this.#input.operationSignal,
        {
          navigationReadiness: request,
          allowLayoutRefresh,
        },
      ),
      ready = proof?.navigationReady;
    if (
      !object(ready) ||
      ready.version !== 1 ||
      typeof ready.ready !== 'boolean' ||
      ready.querySha256 !== request.expectedQuerySha256 ||
      ready.searchPopupHwnd !== searchPopupHwnd
    )
      throw fault('UI_QT_CONTROLS_UNVERIFIED');
    if (
      ready.ready &&
      (ready.primaryTitleSha256 !== request.expectedTitleSha256 ||
        ready.samePage !== true ||
        ready.editorWritable !== true ||
        ready.searchClosed !== true ||
        !validConversationFingerprint(proof.conversationFingerprint))
    )
      throw fault('UI_QT_CONTROLS_UNVERIFIED');
    return {
      ready: ready.ready,
      proof,
    };
  }
  adoptUiaNavigationLayout(candidate, baseline, job, lease) {
    this.#input.active();
    this.#frames.assertTransaction(baseline);
    if (
      this.#frames.config.layoutMode !== 'uia-v1' ||
      this.#frames.navigationPolicy !== 'uia-controls-v1' ||
      this.#input.controlVerificationPolicy !== 'input-boundaries-v1' ||
      !object(this.#frames.config.voice?.recordingUi?.uia ?? this.#frames.config.voice?.recordingUi?.adaptive) ||
      this.#input.current ||
      job.index > 0 ||
      job.pendingInput ||
      this.#input.draftHold ||
      this.#input.sharedDraftResume?.draft ||
      !lease ||
      lease !== this.#focus.preparationLease() ||
      lease.parked ||
      lease.owner !== this.#input.nativeOwner ||
      this.#frames.surface !== 'main' ||
      !object(candidate) ||
      Object.keys(candidate).length !== 4 ||
      candidate.version !== 1 ||
      !object(candidate.binding) ||
      Object.keys(candidate.binding).length !== 7 ||
      !['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi'].every(
        key => candidate.binding[key] === baseline.binding[key],
      ) ||
      !['clientRect', 'captureRect'].every(key => sameRect(candidate.binding[key], baseline.binding[key])) ||
      !object(candidate.layout) ||
      Object.keys(candidate.layout).length !== 7 ||
      !['width', 'height', 'dpi'].every(key => candidate.layout[key] === this.#frames.config.layout[key]) ||
      !['search', 'header', 'editor', 'send'].every(
        key => rect(candidate.layout[key]) && inside(baseline.binding.clientRect, candidate.layout[key]),
      ) ||
      !object(candidate.voice) ||
      Object.keys(candidate.voice).length !== 2 ||
      !['recordStartRect', 'toolbarRect'].every(
        key => rect(candidate.voice[key]) && inside(baseline.binding.clientRect, candidate.voice[key]),
      )
    )
      throw fault('UI_QT_CONTROLS_BINDING_CHANGED');
    const next = structuredClone(this.#frames.config);
    next.layout = structuredClone(candidate.layout);
    next.voice.recordStartRect = structuredClone(candidate.voice.recordStartRect);
    if (next.voice.recordingUi.uia) next.voice.toolbarRect = structuredClone(candidate.voice.toolbarRect);
    else next.voice.recordingUi.adaptive.toolbarRect = structuredClone(candidate.voice.toolbarRect);
    // The native helper keeps its exact lease/search-generation authority. Only
    // observed role regions change; no helper restart or new input grant occurs.
    this.#frames.adoptLayout(next.layout, next.voice);
  }
  async waitForUiaSearchTransition(job, baseline, lookup, searchPopupHwnd, searchGeneration) {
    if (!positiveDecimal(searchPopupHwnd) || !/^[a-f0-9]{32}$/.test(searchGeneration ?? ''))
      throw fault('UI_QT_SEARCH_ENTER_PROOF_INVALID');
    const started = this.#input.now(),
      lease = this.#focus.preparationLease();
    let waited = 0;
    // Poll live readiness; there is no pixel-settling interval in this path.
    // Keep the full 600 ms budget even when reads finish immediately.
    for (let index = 0; index < 61; index++) {
      this.#input.active();
      if (Math.max(this.#input.now() - started, waited) > 600) break;
      const result = await this.uiaConversationReady(job, baseline, lookup, searchPopupHwnd, {
        allowLayoutRefresh: true,
      });
      this.#input.active();
      if (Math.max(this.#input.now() - started, waited) > 600) break;
      if (result.ready) {
        if (result.proof.navigationLayout)
          this.adoptUiaNavigationLayout(result.proof.navigationLayout, baseline, job, lease);
        const focused = await this.#input.requestNative('focusUiaReadyEditor', {
          searchGeneration,
          headerRect: this.#frames.config.layout.header,
          editorRect: this.#frames.config.layout.editor,
          idleMs: this.#frames.config.idleMs,
          uiaReady: {
            version: 1,
            proof: 'uia-controls-v1',
            binding: baseline.binding,
          },
        });
        return {
          frame: this.#frames.acceptUiaEditorFocus(focused, baseline),
          fingerprint: structuredClone(result.proof.conversationFingerprint),
        };
      }
      if (Math.max(this.#input.now() - started, waited) + 10 > 600) break;
      await this.#input.wait(10);
      waited += 10;
    }
    throw fault('UI_QT_SEARCH_TRANSITION_UNCONFIRMED', {
      [navigationTransitionFailure]: true,
    });
  }
  async waitForSearchEnterTransition(baseline) {
    const started = this.#input.now(),
      unchangedGraceMs = 350;
    let waited = 0,
      previous,
      stableSince,
      headerChanged = false;
    for (let index = 0; index < 18; index++) {
      if (index) {
        if (Math.max(this.#input.now() - started, waited) + 35 > 600) break;
        await this.#input.wait(35);
        waited += 35;
      }
      this.#input.active();
      if (Math.max(this.#input.now() - started, waited) > 600) break;
      let current;
      try {
        current = await this.#frames.capture(['header', 'editor'], false, {
          retryPixelChanges: false,
        });
      } catch (error) {
        const mismatch = pixelMismatchDiagnostic(error?.pixelMismatch);
        if (
          error?.attempted !== false ||
          !(
            ['QT_WINDOW_OBSCURED', 'DRAFT_WINDOW_POPUP_ACTIVE', 'DRAFT_WINDOW_NOT_FOREGROUND'].includes(error.code) ||
            (error.code === 'QT_PIXELS_CHANGED' &&
              mismatch?.stage === 'capture' &&
              [0, 1].includes(mismatch.anchorIndex))
          )
        )
          throw error;
        previous = null;
        stableSince = undefined;
        continue;
      }
      if (Math.max(this.#input.now() - started, waited) > 600) break;
      if (
        !['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi'].every(
          key => current.binding[key] === baseline.binding[key],
        ) ||
        !['clientRect', 'captureRect'].every(key => sameRect(current.binding[key], baseline.binding[key])) ||
        current.idleMs < this.#frames.config.idleMs ||
        current.popup ||
        current.regions.length !== 2 ||
        !sameRect(current.regions[0].rect, this.#frames.config.layout.header) ||
        !sameRect(current.regions[1].rect, this.#frames.config.layout.editor)
      )
        throw fault('UI_QT_SEARCH_TRANSITION_CHANGED');
      // Wait for the search UI transition before editor input.
      // Selecting an already open conversation may legitimately keep its header.
      const binding = current.binding,
        caret = binding.caretRectInClient,
        elapsed = Math.max(this.#input.now() - started, waited);
      // Opening a conversation need not focus its editor. An explicit native
      // no-caret snapshot is legal here; the following click focuses the editor.
      const noCaret =
        binding.caretHwnd === '0' &&
        binding.caretBelongsToWindow === false &&
        binding.guiFlags === 0 &&
        object(caret) &&
        Object.keys(caret).length === 4 &&
        ['left', 'top', 'right', 'bottom'].every(key => caret[key] === 0);
      const editorCaret =
        binding.caretHwnd === binding.hwnd &&
        binding.caretBelongsToWindow === true &&
        binding.guiFlags === 1 &&
        rect(caret) &&
        inside(this.#frames.config.layout.editor, caret);
      if (binding.focusHwnd !== binding.hwnd || binding.focusBelongsToWindow !== true || (!noCaret && !editorCaret)) {
        previous = null;
        stableSince = undefined;
        continue;
      }
      // Qt can dismiss search while still painting the previous conversation.
      // Old frames never establish the stability of a newly presented header.
      // An unchanged header can also mean the requested chat was already open;
      // allow that case only after a bounded presentation grace and fresh reads.
      // This observes page completion, not the contact's identity.
      if (baseline.baselinePixelStable === false && elapsed < unchangedGraceMs) {
        previous = null;
        stableSince = undefined;
        continue;
      }
      if (this.#frames.regionDigest(current, 0) !== this.#frames.regionDigest(baseline, 0)) headerChanged = true;
      else if (headerChanged || elapsed < unchangedGraceMs) {
        previous = null;
        stableSince = undefined;
        continue;
      }
      const same =
        previous && current.regions.every((entry, index) => entry.rgbaSha256 === previous.regions[index].rgbaSha256);
      if (!same) stableSince = elapsed;
      if (same && elapsed - stableSince >= 35) return current;
      previous = current;
    }
    throw fault('UI_QT_SEARCH_TRANSITION_UNCONFIRMED', {
      [navigationTransitionFailure]: true,
    });
  }
  async waitForSharedSearchQuery() {
    const uia = this.#frames.config.layoutMode === 'uia-v1' && this.#frames.navigationPolicy === 'uia-controls-v1',
      cadence = uia ? 10 : 35,
      maxReads = uia ? 61 : 18;
    const started = this.#input.now();
    let waited = 0;
    for (let index = 0; index < maxReads; index++) {
      if (index) {
        if (Math.max(this.#input.now() - started, waited) + cadence > 600) break;
        await this.#input.wait(cadence);
        waited += cadence;
      }
      this.#input.active();
      if (Math.max(this.#input.now() - started, waited) > 600) break;
      try {
        const frame = await this.#frames.capture(['search'], false, {
          retryPixelChanges: false,
        });
        if (Math.max(this.#input.now() - started, waited) <= 600) return frame;
        break;
      } catch (error) {
        const mismatch = pixelMismatchDiagnostic(error?.pixelMismatch);
        if (
          error?.attempted !== false ||
          !(
            ['QT_POPUP_CANDIDATE_NOT_UNIQUE', 'QT_POPUP_UNSTABLE'].includes(error.code) ||
            (error.code === 'QT_PIXELS_CHANGED' && mismatch?.stage === 'capture' && mismatch.anchorIndex === 0)
          )
        )
          throw error;
      }
    }
    throw fault('UI_QT_SEARCH_TRANSITION_UNCONFIRMED', {
      [navigationTransitionFailure]: true,
    });
  }
  async prepareSharedSearch(
    job,
    displayedId,
    baseline,
    voicePreparation,
    searchKind = job.target.endsWith('@chatroom') ? 'group-title' : undefined,
    uiaNavigation,
    targetLookup,
  ) {
    baseline ??= await this.#frames.capture(['header']);
    if (uiaNavigation) baseline = await this.openUiaSearch(baseline, uiaNavigation);
    else
      await this.#input.sharedAction(
        'chord',
        {
          key: 'Control+F',
          ...this.popupTransition('search'),
        },
        ['header'],
        baseline,
      );
    const { frame, entered, querySha256 } = await this.enterSharedSearch(displayedId, {
      baseline,
      searchKind,
      uiaNavigation,
    });
    voicePreparation?.start(baseline);
    const uiaReady =
      this.#frames.config.layoutMode === 'uia-v1' && uiaNavigation && uiaTargetEvidence(targetLookup)
        ? await this.waitForUiaSearchTransition(
            job,
            baseline,
            targetLookup,
            frame.popup?.hwnd,
            entered.searchGeneration,
          )
        : null;
    const opened = uiaReady?.frame ?? (await this.waitForSearchEnterTransition(baseline));
    if (voicePreparation) voicePreparation.readyFrame = opened;
    return Object.freeze({
      kind: 'database-query-search-enter-v1',
      account: job.account,
      target: job.target,
      querySha256,
      header: this.#frames.regionDigest(opened, 0),
      ...(uiaReady
        ? {
            uiaConversationFingerprint: uiaReady.fingerprint,
            titleSha256: targetLookup.uiaTarget.titleSha256,
            editorFocused: true,
          }
        : {}),
      ...(searchKind
        ? {
            searchKind,
          }
        : {}),
    });
  }
  async enterSharedSearch(displayedId, { baseline, searchKind, uiaNavigation } = {}) {
    this.#frames.invalidateFrame('search');
    const before = await this.waitForSharedSearchQuery();
    this.#input.active();
    let pasted;
    try {
      pasted = this.#input.appliedPaste(
        await this.#input.requestNative('paste', {
          allowClipboardReplacement: this.#input.allowClipboardReplacement,
          token: before.token,
          epoch: before.epoch,
          revision: before.revision,
          idleMs: this.#frames.config.idleMs,
          text: displayedId,
          expectedText: displayedId,
          scope: 'search',
          ...(searchKind
            ? {
                searchKind,
              }
            : {}),
          replaceSearch: true,
          readback: false,
          ...(!this.#focus.preparationLease()
            ? {
                foregroundOnly: true,
              }
            : {}),
        }),
        displayedId,
      );
    } catch (error) {
      // A refused backup leaves the search open. Confirm its dismissal before
      // offering the queue another attempt to open it.
      if (
        error.originalClipboardBlocked === true &&
        error.attempted === false &&
        error.clipboardRestored === true &&
        this.#focus.preparationLease() &&
        baseline &&
        !uiaNavigation &&
        observedLayout(this.#frames.config)
      ) {
        try {
          await this.closeObservedSearch(baseline);
        } catch {
          throw fault('UI_QT_SEARCH_CLOSE_UNVERIFIED', {
            popupCleanup: {
              closed: false,
            },
          });
        }
      }
      throw error;
    }
    if (pasted.interrupted)
      throw fault('QT_HUMAN_ACTIVITY_CHANGED', {
        attempted: false,
        ...clipboardOutcome(pasted),
      });
    const frame = this.#frames.acceptPostPasteFrame(pasted.postPasteFrame, before, ['search']),
      proof = pasted.searchEnterProof,
      querySha256 = crypto.createHash('sha256').update(displayedId).digest('hex');
    if (
      !object(proof) ||
      Object.keys(proof).length !== 3 ||
      proof.version !== 1 ||
      !/^[a-f0-9]{32}$/.test(proof.id ?? '') ||
      proof.querySha256 !== querySha256
    )
      throw fault('UI_QT_SEARCH_ENTER_PROOF_INVALID');
    this.#input.active();
    const entered = await this.#input.requestNative('searchEnter', {
      token: frame.token,
      epoch: frame.epoch,
      revision: frame.revision,
      idleMs: this.#frames.config.idleMs,
      searchEnterProofId: proof.id,
      querySha256,
    });
    this.#frames.invalidateFrame();
    if (
      entered.performed !== true ||
      entered.attempted !== true ||
      entered.searchAccepted !== true ||
      entered.revision !== this.#frames.transaction.revision
    )
      throw fault('UI_QT_SEARCH_ENTER_UNCERTAIN');
    this.#frames.invalidateFrame('main');
    return { frame, entered, querySha256 };
  }
}
export { QtNavigationSession };
