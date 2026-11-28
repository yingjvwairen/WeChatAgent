import fs from 'node:fs';
import { fault, rect, noLinks } from './qt-contract.mjs';
import {
  quoteDraftFile,
  readQuoteDraft,
  confirmQuoteDraftSent,
  beginQuoteDraft,
  bindQuoteDraft,
} from './quote-draft-state.mjs';

// Quotes use the current conversation and its frame bindings; they do not create a second input session.
export class QtQuoteSession {
  constructor({
    root,
    frames,
    active,
    requestNative,
    hasFocus,
    textStepBinding,
    verifyControlBinding,
    recognize,
    wait,
    discardNativeFrameImage,
  }) {
    Object.assign(this, {
      root,
      frames,
      active,
      requestNative,
      hasFocus,
      textStepBinding,
      verifyControlBinding,
      recognize,
      wait,
      discardNativeFrameImage,
    });
  }
  get config() {
    return this.frames.config;
  }
  region(name) {
    return this.frames.region(name);
  }
  capture(...args) {
    return this.frames.capture(...args);
  }
  confirm(job) {
    return confirmQuoteDraftSent(this.root, this.config.accountRef, job.target, job.id);
  }
  async prepare(job, verified, signal) {
    const marker = quoteDraftFile(this.root, this.config.accountRef, job.target);
    if (fs.existsSync(marker)) {
      noLinks(marker);
      const old = readQuoteDraft(this.root, this.config.accountRef, job.target);
      let clear;
      if (this.config.layoutMode === 'uia-v1' || old.mode === 'uia') {
        const f = verified.frame;
        clear =
          (
            await this.requestNative('checkClearMessageQuote', {
              token: f.token,
              epoch: f.epoch,
              revision: f.revision,
              idleMs: this.config.idleMs,
            })
          ).clear === true;
      } else if (old.bound === true && old.mode === 'ocr') {
        const { verifyNoOcrQuote } = await import('./qt-quote-ocr.mjs');
        clear = await verifyNoOcrQuote(this, job, verified.frame, signal, verified.verifiedEmptyHashes);
      }
      if (clear !== true) throw fault('UI_QT_QUOTE_DRAFT_CONFLICT');
      confirmQuoteDraftSent(this.root, this.config.accountRef, job.target, old.id);
      verified.frame = await this.capture(['header', 'editor']);
    }
    let quoteToken, quoteNavigation;
    if (job.quote) {
      if (!this.hasFocus() || verified.draft || job.pendingInput || job.index > 0)
        throw fault('UI_QT_QUOTE_DRAFT_CONFLICT');
      const mode = this.config.layoutMode === 'uia-v1' ? 'uia' : 'ocr';
      beginQuoteDraft(this.root, this.config.accountRef, job.target, job.id, mode);
      let attachment;
      try {
        attachment = await this.attachMessageQuote(job, verified.frame, signal);
      } catch (error) {
        if (error.quoteDraftUntouched === true && error.attempted === false)
          confirmQuoteDraftSent(this.root, this.config.accountRef, job.target, job.id);
        throw error;
      }
      bindQuoteDraft(this.root, this.config.accountRef, job.target, job.id, attachment.mode ?? mode);
      quoteToken = attachment.quoteToken;
      quoteNavigation = attachment.historyNavigation;
      if (this.config.layoutMode === 'uia-v1') {
        this.frames.useQuoteEditor(attachment.editorRect);
      }
      verified.frame = await this.capture(['header', 'editor']);
      await this.verifyControlBinding(job, verified.frame, 'prepare', signal);
    }
    return { quoteToken, quoteNavigation };
  }
  async attachMessageQuote(job, frame, signal) {
    this.active();
    let attached, history;
    const refresh = async () => {
      this.frames.invalidateFrame();
      frame = await this.capture(['header', 'editor']);
      return frame;
    };
    const native = async allowHistoryScroll => {
      const value = await this.requestNative('attachMessageQuote', {
        token: frame.token,
        epoch: frame.epoch,
        revision: frame.revision,
        idleMs: this.config.idleMs,
        stepBinding: this.textStepBinding(job),
        quoteText: job.quote.text,
        fromSelf: job.quote.sender === job.account,
        allowHistoryScroll,
        ...(job.quote.locator
          ? {
              quoteKind: job.quote.kind,
              quoteLocator: job.quote.locator,
            }
          : {}),
      });
      return {
        ...value,
        mode: 'uia',
      };
    };
    const ocr = async allowScroll => {
      const { attachOcrQuote } = await import('./qt-quote-ocr.mjs');
      return attachOcrQuote(this, job, frame, signal, {
        allowScroll,
      });
    };
    try {
      const { attachQuoteNavigation, locateQuoteViaHistory } = await import('./quote-history-client.mjs');
      const result = await attachQuoteNavigation({
        uia: this.config.layoutMode === 'uia-v1',
        rich: Boolean(job.quote.locator),
        native,
        ocr,
        refresh,
        history: () => locateQuoteViaHistory(this, job, frame, signal),
      });
      attached = result.attached;
      history = result.navigation;
    } catch (error) {
      if (
        error.attempted === false &&
        [
          'QT_QUOTE_SOURCE_NOT_VISIBLE',
          'QT_QUOTE_SOURCE_AMBIGUOUS',
          'QT_QUOTE_SOURCE_OBSCURED',
          'QT_UIA_CONTROL_ROOT_INVALID',
          'QT_UIA_CONTROL_UNAVAILABLE',
        ].includes(error.code)
      )
        throw fault('UI_QUOTE_TARGET_UNAVAILABLE', {
          attempted: false,
          quoteDraftUntouched: true,
        });
      throw error;
    }
    if (
      signal?.aborted ||
      attached?.attached !== true ||
      !/^[a-f0-9]{32}$/.test(attached.quoteToken) ||
      !rect(attached.editorRect)
    )
      throw fault('UI_QT_QUOTE_PREVIEW_UNVERIFIED');
    return {
      ...attached,
      ...(history
        ? {
            historyNavigation: {
              strategy: 'history-search',
              found: history.found === true,
              navigationAttempted: history.navigationAttempted === true,
              cleanupConfirmed: history.cleanupConfirmed === true,
              historyCreated: history.historyCreated === true,
              historyPreserved: history.historyPreserved === true,
              pointMethod: history.pointMethod ?? null,
            },
          }
        : {}),
    };
  }
}
