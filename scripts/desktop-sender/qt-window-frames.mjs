import { isDeepStrictEqual } from 'node:util';
import {
  fault,
  object,
  rect,
  hash,
  inside,
  observedLayout,
  positiveDecimal,
  sameRect,
  validateQtConfig,
  uiaEditorFocusReused,
  validUiaPointerDelivery,
  validConversationFingerprint,
} from './qt-contract.mjs';

export class QtWindowFrames {
  #frame = null;
  #surface = 'main';
  #transaction = null;
  #popupAreas = {};
  #searchRegion = null;
  #originalEditor;
  #config;
  #request;
  #navigationPolicy;
  #active;
  #wait;
  #hasForegroundLease;
  constructor({ config, navigationPolicy, request, active, wait, hasForegroundLease }) {
    this.#config = validateQtConfig(config);
    this.#navigationPolicy = navigationPolicy;
    this.#request = request;
    this.#active = active;
    this.#wait = wait;
    this.#hasForegroundLease = hasForegroundLease;
  }
  get navigationPolicy() {
    return this.#navigationPolicy;
  }
  get config() {
    return this.#config;
  }
  get frame() {
    return this.#frame;
  }
  get surface() {
    return this.#surface;
  }
  get transaction() {
    return this.#transaction;
  }
  clearTransaction() {
    this.#transaction = null;
  }
  useQuoteEditor(area) {
    this.#originalEditor ??= this.#config.layout.editor;
    this.#config.layout.editor = area;
  }
  restoreEditor() {
    if (this.#originalEditor) {
      this.#config.layout.editor = this.#originalEditor;
      this.#originalEditor = null;
    }
  }
  invalidateFrame(surface = this.#surface) {
    this.#frame = null;
    this.#surface = surface;
  }
  rememberFrame(frame) {
    this.#frame = frame;
    return frame;
  }
  invalidatePopupGeometry(surface) {
    if (surface === 'search') this.#searchRegion = null;
    if (observedLayout(this.config)) delete this.#popupAreas[surface];
  }
  adoptLayout(layout, voice = this.config.voice) {
    this.#config = validateQtConfig({ ...this.config, layout, ...(voice ? { voice } : {}) });
  }
  bindInputTransaction(frame) {
    this.#transaction = {
      epoch: frame.epoch,
      revision: frame.revision,
      pid: frame.binding.pid,
      created: frame.binding.processCreatedFileTimeUtc,
    };
  }
  assertTransaction(frame) {
    const metadata = frame?.observationKind === 'uia-metadata-v1';
    if (
      metadata
        ? frame.pixelsRead !== false ||
          frame.pixelFormat !== undefined ||
          frame.image != null ||
          this.navigationPolicy !== 'uia-controls-v1'
        : frame?.pixelFormat !== 'rgba-row-major-opaque-v1'
    )
      throw fault('UI_QT_NATIVE_UPDATE_REQUIRED');
    const binding = frame?.binding,
      layout = this.config.layout,
      surface =
        this.surface === 'profile'
          ? this.config.profileSurface
          : this.surface === 'self'
            ? this.config.selfSurface
            : null,
      observed = observedLayout(this.config) && surface ? frame.popup?.clientRect : null;
    if (
      !object(binding) ||
      (!surface && this.config.hwnd !== 'auto' && binding.hwnd !== this.config.hwnd) ||
      !/^[1-9][0-9]{0,18}$/.test(binding.hwnd ?? '') ||
      binding.foreground !== true ||
      !Number.isSafeInteger(binding.pid) ||
      !/^[1-9][0-9]{0,18}$/.test(binding.processCreatedFileTimeUtc ?? '') ||
      binding.dpi !== layout.dpi ||
      binding.clientRect?.right !== (observed?.right ?? surface?.width ?? layout.width) ||
      binding.clientRect?.bottom !== (observed?.bottom ?? surface?.height ?? layout.height) ||
      binding.clientRect?.left !== 0 ||
      binding.clientRect?.top !== 0 ||
      !Number.isSafeInteger(frame.revision) ||
      frame.revision < 0 ||
      !Number.isFinite(frame.idleMs) ||
      frame.idleMs < 0 ||
      !/^[a-f0-9]{32}$/.test(frame.epoch ?? '') ||
      !/^[a-f0-9]{32}$/.test(frame.token ?? '') ||
      !Array.isArray(frame.regions) ||
      frame.regions.some(
        item =>
          !rect(item.rect) ||
          (metadata
            ? !['header', 'editor', 'search', 'send'].includes(item.role) ||
              !hash(item.controlSha256) ||
              item.rgbaSha256 !== undefined
            : !hash(item.rgbaSha256)),
      )
    )
      throw fault('UI_QT_OBSERVATION_INVALID');
    if (
      this.#transaction &&
      (frame.epoch !== this.#transaction.epoch ||
        frame.revision !== this.#transaction.revision ||
        binding.pid !== this.#transaction.pid ||
        binding.processCreatedFileTimeUtc !== this.#transaction.created)
    )
      throw fault('UI_QT_HUMAN_ACTIVITY_CHANGED');
  }
  regionDigest(frame, index = 0) {
    return frame?.observationKind === 'uia-metadata-v1'
      ? frame.regions?.[index]?.controlSha256
      : frame?.regions?.[index]?.rgbaSha256;
  }
  region(name) {
    if (name === 'search' && this.surface === 'search' && this.config.layoutMode === 'uia-v1' && this.#searchRegion)
      return this.#searchRegion.rect;
    if (observedLayout(this.config) && ['profileAlias', 'selfAlias', 'searchResultIdentity'].includes(name)) {
      const area = this.#popupAreas?.[this.surface];
      if (!rect(area)) throw fault('UI_QT_POPUP_OBSERVATION_REQUIRED');
      return area;
    }
    const surface =
      this.surface === 'profile'
        ? this.config.profileSurface
        : this.surface === 'self'
          ? this.config.selfSurface
          : null;
    return surface && ['profileAlias', 'selfAlias'].includes(name)
      ? surface.alias
      : surface && ['profileClose', 'selfClose'].includes(name)
        ? surface.close
        : this.config.layout[name];
  }
  async capture(names = ['header'], image = false, { retryPixelChanges = true } = {}) {
    this.#active();
    const uia = this.config.layoutMode === 'uia-v1' && this.navigationPolicy === 'uia-controls-v1';
    if (uia && this.surface === 'main' && names.length === 1 && names[0] === 'header' && !image)
      return this.captureUiaNavigation();
    if (
      uia &&
      (image ||
        !(
          (this.surface === 'main' && names.join(',') === 'header,editor') ||
          (this.surface === 'search' && names.join(',') === 'search')
        ))
    )
      throw fault('UI_QT_CONTROLS_POLICY_INVALID');
    const calibration = this.popupCalibration(),
      adaptive = observedLayout(this.config) && Boolean(calibration);
    const request = {
      regions: names.map(name => (typeof name === 'string' ? this.region(name) : name)),
      image,
      surface: calibration
        ? `${adaptive ? 'observed' : 'calibrated'}-${this.surface === 'search' ? 'search' : 'profile'}`
        : this.surface === 'main'
          ? 'main'
          : 'owned-profile',
      ...(calibration
        ? {
            surfaceId: this.surface,
          }
        : {}),
    };
    let frame;
    for (let attempt = 0; ; attempt++) {
      try {
        frame = await this.#request(
          uia ? (this.surface === 'search' ? 'captureUiaSearch' : 'captureUiaControls') : 'capture',
          request,
        );
        break;
      } catch (error) {
        // A caret may blink between the two reads of a read-only screenshot.
        // Retry only that observation; never repeat a keyboard/mouse action or
        // an account, activity, focus or clipboard failure.
        if (!retryPixelChanges || error?.code !== 'QT_PIXELS_CHANGED' || attempt >= 3) throw error;
        await this.#wait(25);
        this.#active();
      }
    }
    if (
      calibration &&
      (!object(frame.popup) ||
        frame.popup.surfaceId !== this.surface ||
        frame.popup.kind !== calibration.kind ||
        frame.popup.ownerRelation !== calibration.ownerRelation ||
        frame.popup.stableObservations !== 2 ||
        !positiveDecimal(frame.popup.hwnd) ||
        (this.surface === 'search'
          ? frame.popup.hwnd === frame.binding?.hwnd
          : frame.popup.hwnd !== frame.binding?.hwnd))
    )
      throw fault('UI_QT_POPUP_BINDING_INVALID');
    if (adaptive) {
      const p = frame.popup,
        client = p?.clientRect,
        rootArea = p?.clientRectInRoot,
        window = p?.windowRect,
        offscreen = this.uiaOffscreenSearchFrame(frame);
      const signedRect = value =>
        object(value) &&
        Object.keys(value).length === 4 &&
        ['left', 'top', 'right', 'bottom'].every(
          key => Number.isSafeInteger(value[key]) && Math.abs(value[key]) <= 65536,
        ) &&
        value.right > value.left &&
        value.bottom > value.top;
      if (
        (p.offscreenSearch !== undefined && !offscreen) ||
        p.geometryMode !== 'observed-v1' ||
        p.dpi !== this.config.layout.dpi ||
        !rect(client) ||
        client.left !== 0 ||
        client.top !== 0 ||
        client.right < 20 ||
        client.bottom < 20 ||
        client.right > 4096 ||
        client.bottom > 4096 ||
        client.right * client.bottom > 12000000 ||
        !signedRect(window) ||
        !signedRect(rootArea) ||
        rootArea.right - rootArea.left !== client.right ||
        rootArea.bottom - rootArea.top !== client.bottom ||
        (this.surface === 'search' &&
          !offscreen &&
          !inside(
            {
              left: 0,
              top: 0,
              right: this.config.layout.width,
              bottom: this.config.layout.height,
            },
            rootArea,
          ))
      )
        throw fault('UI_QT_POPUP_BINDING_INVALID');
      this.#popupAreas[this.surface] = this.surface === 'search' ? structuredClone(rootArea) : structuredClone(client);
      if (
        names.length === 0 &&
        (frame.regions?.length !== 1 || !sameRect(frame.regions[0].rect, this.#popupAreas[this.surface]))
      )
        throw fault('UI_QT_POPUP_BINDING_INVALID');
    }
    this.#active();
    this.assertTransaction(frame);
    if (uia && this.surface === 'search') {
      if (
        frame.observationKind !== 'uia-metadata-v1' ||
        frame.pixelsRead !== false ||
        frame.regions.length !== 1 ||
        frame.regions[0].role !== 'search' ||
        !inside(frame.binding.clientRect, frame.regions[0].rect)
      )
        throw fault('UI_QT_POPUP_BINDING_INVALID');
      this.#searchRegion = {
        popupHwnd: frame.popup.hwnd,
        rect: structuredClone(frame.regions[0].rect),
      };
    }
    return this.rememberFrame(frame);
  }
  acceptPostPasteFrame(value, before, names, { conversationFingerprint } = {}) {
    this.assertTransaction(value);
    const dynamicSearch =
      this.surface === 'search' &&
      before.observationKind === 'uia-metadata-v1' &&
      value.observationKind === 'uia-metadata-v1' &&
      names.length === 1 &&
      names[0] === 'search';
    if (
      value.idleMs < this.config.idleMs ||
      !['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi'].every(
        key => value.binding[key] === before.binding[key],
      ) ||
      !['clientRect', 'captureRect'].every(key => sameRect(value.binding[key], before.binding[key])) ||
      value.regions.length !== names.length ||
      !value.regions.every((entry, index) =>
        dynamicSearch
          ? entry.role === 'search' && inside(value.binding.clientRect, entry.rect)
          : sameRect(entry.rect, this.region(names[index])),
      )
    )
      throw fault('UI_QT_PASTE_UNVERIFIED');
    if (this.surface === 'search') {
      const a = before.popup,
        b = value.popup;
      if (
        !a ||
        !b ||
        !['hwnd', 'surfaceId', 'kind', 'ownerRelation', 'geometryMode', 'dpi', 'stableObservations'].every(
          key => a[key] === b[key],
        )
      )
        throw fault('UI_QT_PASTE_UNVERIFIED');
      if (a.offscreenSearch !== undefined || b.offscreenSearch !== undefined) {
        if (
          !dynamicSearch ||
          !this.uiaOffscreenSearchFrame(before) ||
          !this.uiaOffscreenSearchFrame(value) ||
          a.clientRect.right !== b.clientRect.right ||
          a.windowRect.right - a.windowRect.left !== b.windowRect.right - b.windowRect.left ||
          !isDeepStrictEqual(this.uiaOffscreenPopupMargins(before), this.uiaOffscreenPopupMargins(value))
        )
          throw fault('UI_QT_PASTE_UNVERIFIED');
      } else if (
        !['clientRect', 'clientRectInRoot', 'windowRect'].every(
          key => object(b[key]) && ['left', 'top', 'right'].every(axis => a[key][axis] === b[key][axis]),
        ) ||
        !rect(b.clientRect) ||
        !rect(b.clientRectInRoot) ||
        !inside(value.binding.clientRect, b.clientRectInRoot) ||
        !inside(value.binding.captureRect, b.windowRect) ||
        b.clientRectInRoot.bottom - b.clientRectInRoot.top !== b.clientRect.bottom ||
        b.windowRect.bottom - value.binding.captureRect.top - b.clientRectInRoot.bottom !==
          a.windowRect.bottom - before.binding.captureRect.top - a.clientRectInRoot.bottom
      )
        throw fault('UI_QT_PASTE_UNVERIFIED');
    } else if (
      value.popup ||
      (this.regionDigest(value) !== this.regionDigest(before) &&
        !(
          before.uiaControlFrame === true &&
          value.uiaControlFrame === true &&
          this.navigationPolicy === 'uia-controls-v1' &&
          validConversationFingerprint(conversationFingerprint)
        ))
    )
      throw fault('UI_QT_PASTE_UNVERIFIED');
    if (
      before.observationKind === 'uia-metadata-v1' &&
      (value.observationKind !== 'uia-metadata-v1' ||
        value.regions.some((entry, index) => entry.role !== names[index]) ||
        (this.surface !== 'search' && (before.uiaControlFrame !== true || value.uiaControlFrame !== true)))
    )
      throw fault('UI_QT_PASTE_UNVERIFIED');
    if (dynamicSearch)
      this.#searchRegion = {
        popupHwnd: value.popup.hwnd,
        rect: structuredClone(value.regions[0].rect),
      };
    return this.rememberFrame(value);
  }
  acceptUiaEditorFocus(result, baseline) {
    const frame = result?.postFocusFrame;
    this.assertTransaction(frame);
    if (
      result.performed !== true ||
      (result.attempted !== true && !uiaEditorFocusReused(result)) ||
      (result.pointerDelivery != null && !validUiaPointerDelivery(result.pointerDelivery, 'editor-focus')) ||
      result.editorFocused !== true ||
      frame.observationKind !== 'uia-metadata-v1' ||
      frame.pixelsRead !== false ||
      frame.regions?.[0]?.role !== 'header' ||
      frame.regions?.[1]?.role !== 'editor' ||
      frame.uiaControlFrame !== true ||
      frame.navigationOnly === true ||
      frame.popup ||
      frame.regions.length !== 2 ||
      !sameRect(frame.regions[0].rect, this.config.layout.header) ||
      !sameRect(frame.regions[1].rect, this.config.layout.editor) ||
      !['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi'].every(
        key => frame.binding[key] === baseline.binding[key],
      ) ||
      !['clientRect', 'captureRect'].every(key => sameRect(frame.binding[key], baseline.binding[key]))
    )
      throw fault('UI_QT_CONTROLS_BINDING_CHANGED');
    return this.rememberFrame(frame);
  }
  uiaOffscreenSearchFrame(frame) {
    const p = frame?.popup,
      b = frame?.binding,
      c = p?.clientRect,
      a = p?.clientRectInRoot,
      w = p?.windowRect;
    const signed = value =>
      object(value) &&
      Object.keys(value).length === 4 &&
      ['left', 'top', 'right', 'bottom'].every(
        key => Number.isSafeInteger(value[key]) && Math.abs(value[key]) <= 65536,
      ) &&
      value.right > value.left &&
      value.bottom > value.top;
    if (
      this.config.layoutMode !== 'uia-v1' ||
      this.navigationPolicy !== 'uia-controls-v1' ||
      frame?.observationKind !== 'uia-metadata-v1' ||
      frame.pixelsRead !== false ||
      p?.offscreenSearch !== true ||
      p.surfaceId !== 'search' ||
      p.kind !== 'search' ||
      p.ownerRelation !== 'root-owned' ||
      p.geometryMode !== 'observed-v1' ||
      p.stableObservations !== 2 ||
      !positiveDecimal(p.hwnd) ||
      p.hwnd === b?.hwnd ||
      p.dpi !== b?.dpi ||
      !rect(c) ||
      c.left !== 0 ||
      c.top !== 0 ||
      c.right < 20 ||
      c.bottom < 20 ||
      !signed(a) ||
      !signed(w) ||
      !signed(b?.captureRect) ||
      !rect(b?.clientRect) ||
      c.right > b.clientRect.right ||
      c.bottom > b.clientRect.bottom
    )
      return false;
    const screen = {
      left: b.captureRect.left + a.left,
      top: b.captureRect.top + a.top,
      right: b.captureRect.left + a.right,
      bottom: b.captureRect.top + a.bottom,
    };
    return (
      b.clientRect.left === 0 &&
      b.clientRect.top === 0 &&
      a.right - a.left === c.right &&
      a.bottom - a.top === c.bottom &&
      w.right - w.left <= b.clientRect.right &&
      w.bottom - w.top <= b.clientRect.bottom &&
      inside(w, screen) &&
      frame.regions?.length === 1 &&
      frame.regions[0].role === 'search' &&
      rect(frame.regions[0].rect) &&
      inside(b.clientRect, frame.regions[0].rect)
    );
  }
  uiaOffscreenPopupMargins(frame) {
    const p = frame.popup,
      w = p.windowRect,
      a = p.clientRectInRoot,
      b = frame.binding.captureRect;
    return [a.left + b.left - w.left, a.top + b.top - w.top, w.right - a.right - b.left, w.bottom - a.bottom - b.top];
  }
  popupCalibration(surface = this.surface) {
    return surface === 'search'
      ? this.config.searchPopupCalibration
      : surface === 'self'
        ? this.config.selfSurface?.popupCalibration
        : surface === 'profile'
          ? this.config.profileSurface?.popupCalibration
          : null;
  }
  async captureUiaNavigation() {
    this.#active();
    if (this.navigationPolicy !== 'uia-controls-v1' || this.surface !== 'main' || !this.#hasForegroundLease())
      throw fault('UI_QT_CONTROLS_UNVERIFIED');
    const frame = await this.#request('captureUiaNavigation', {
      surface: 'main',
      regions: [this.config.layout.header],
      image: false,
    });
    this.#active();
    this.assertTransaction(frame);
    if (
      frame.inputSent !== false ||
      frame.observationKind !== 'uia-metadata-v1' ||
      frame.pixelsRead !== false ||
      frame.baselinePixelStable !== false ||
      frame.navigationOnly !== true ||
      frame.popup ||
      frame.regions.length !== 1 ||
      frame.regions[0].role !== 'header' ||
      !sameRect(frame.regions[0].rect, this.config.layout.header)
    )
      throw fault('UI_QT_OBSERVATION_INVALID');
    return this.rememberFrame(frame);
  }
}
