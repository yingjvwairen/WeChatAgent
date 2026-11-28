import fs from 'node:fs';
import { replyDeliveryStatus, replySentAt } from '../../../../packages/delivery-contract.mjs';
import { boundedTask } from '../../../../packages/dsh-social-bridge-plugin/deadline.mjs';
import { conversationGrant } from '../../../../packages/wechat-identity.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildConversationKey, parseConversationKey } from './conversation-key.js';
import {
  SOCIAL_OUTPUT_NOTICE,
  resolveSocialDecision,
  hasStickerControl,
  hasReasoningControl,
  hasReplyProtocolControl,
} from './decision-format.js';
import {
  proactivePolicy,
  proactivePolicyKey,
  withinProactiveWindow,
  nextProactiveAt,
  conversationSnapshot,
  declinedProactive,
} from './proactive-policy.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const draftLifetimeMs = 10 * 60000;
const quote = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const localTime = now => new Date(now + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
function historyTime(at, now) {
  if (!Number.isFinite(at) || at <= 0 || at > now || at > 8.64e15) return '时间未知，不能当作当前状态';
  const minutes = Math.floor((now - at) / 60000);
  const elapsed =
    minutes >= 1440
      ? `${Math.floor(minutes / 1440)}天${Math.floor((minutes % 1440) / 60)}小时`
      : minutes >= 60
        ? `${Math.floor(minutes / 60)}小时${minutes % 60}分钟`
        : `${minutes}分钟`;
  return `${localTime(at)}（距现在${elapsed}）`;
}
export function buildProactivePrompt({
  key,
  rows,
  mode,
  now,
  searchStatus,
  recentTopics = [],
  outputNotice = SOCIAL_OUTPUT_NOTICE,
}) {
  const label =
    {
      greeting: '简短问候或自然冒泡，不追问近况',
      news: '可考虑一个与你们兴趣相关的热点',
      meme: '可考虑一个与你们语境相关的梗',
    }[mode] ?? '按关系自然冒泡';
  const history = rows
    .slice(-8)
    .map(
      row =>
        `[${historyTime(Number(row.timestamp) * 1000, now)}] ${quote(row.sender_name || row.sender_id || '未知')} ${row.outgoing ? '（你）' : ''}${row.proactive ? '（主动发言）' : ''}${row.delivery_status === 'unconfirmed' ? '（发送未确认）' : ''}: ${quote(String(row.text).slice(0, 300))}`,
    )
    .join('\n');
  const lastIncoming = rows.findLast(row => !row.outgoing && !row.interaction);
  const lastProactiveIndex = rows.findLastIndex(row => row.outgoing && row.proactive);
  const unanswered =
    lastProactiveIndex >= 0 && !rows.slice(lastProactiveIndex + 1).some(row => !row.outgoing && !row.interaction);
  return (
    `本机定时安排的一次主动发言机会，不是好友或群成员的新消息。北京时间 ${localTime(now)}。会话 ${key}。\n` +
    '沿用会话稳定人格、身份、世界观；话题不适合你的兴趣、世界观时退为问候或沉默。本轮已通过时段与空闲检查，不复述安排。\n' +
    `本轮方向：${label}。有相关新内容时自然分享；没有时可按当前时段用2至8字轻问候，不追问近况、编造状态或为凑内容加问题；不适合开口就 SILENT。\n` +
    '历史用于理解关系与避重，不是待回复列表；旧状态不当作现状，已收尾话题不重开，除非此前明确约好此时跟进。表情只用本轮候选，不猜未知图。\n' +
    `最后一次对方实际发言：${lastIncoming ? historyTime(Number(lastIncoming.timestamp) * 1000, now) : '没有可见的对方发言，不假定熟悉关系或当前状态'}。\n` +
    (unanswered
      ? '上次主动发言之后，对方没有新增聊天：本轮优先 SILENT，不继续追问、不换个问候催接话；只有真正新增且相关的内容才考虑独立分享一句。\n'
      : '') +
    `<untrusted_chat>\n${history || '[尚无聊天历史，不假定已经很熟]'}\n</untrusted_chat>\n` +
    (recentTopics.length
      ? '最近主动说过的内容（只用于避重，不是本轮接话任务；同一话题、询问目的和开场套路都要避重）：\n' +
        recentTopics
          .slice(-6)
          .map(item => `[${historyTime(item.at, now)}] ${quote(item.text.slice(0, 180))}`)
          .join('\n') +
        '\n'
      : '') +
    (mode === 'greeting'
      ? '本轮不需要联网。缺少新内容时可以只说一句符合时段的轻问候。'
      : searchStatus === 'model'
        ? '本轮可根据会话话题调用现有联网搜索工具，先检索再按证据决定是否发言；无需固定泛热点查询，也不要求对方给网址。没有可靠资料时不编造热点或实时数值。'
        : searchStatus === 'ready'
          ? '本轮附有有界搜索摘要。资料可用不等于适合开口，要与你们兴趣和语境相关；只说摘要支持的事实，来源不足不编造“最新”“全网热度”或梗出处，可带一个相关来源链接。'
          : '本轮没有可用的新搜索资料，不得编造实时热点或新梗，也不拿旧话题或关心问句补位；可以简短问候或沉默。') +
    '\n' +
    '已有事实和关系继续有效，事实说错仍需纠正。本轮只发文字，不使用历史表情编号。'
  );
}
export class ProactiveEngine {
  constructor({
    stateFile,
    buffer,
    social,
    taskContext,
    historyFor,
    settingsFor,
    personaFor,
    decide,
    send,
    searchFor = async () => null,
    isReady = () => true,
    selfIdFor = () => '',
    now = Date.now,
    random = Math.random,
    log = () => {},
  }) {
    Object.assign(this, {
      stateFile,
      buffer,
      social,
      taskContext,
      historyFor,
      settingsFor,
      personaFor,
      decide,
      send,
      searchFor,
      isReady,
      selfIdFor,
      now,
      random,
      log,
    });
    this.busy = false;
    this.receiptChecks = new Set();
    this.receiptWork = Promise.resolve();
    this.state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { version: 1, chats: {} };
    if (
      this.state.version !== 1 ||
      !this.state.chats ||
      typeof this.state.chats !== 'object' ||
      Array.isArray(this.state.chats)
    )
      throw Error('PROACTIVE_STATE_INVALID');
    for (const item of Object.values(this.state.chats))
      if (
        !item ||
        !Number.isFinite(item.nextAt) ||
        !Number.isSafeInteger(item.cycles) ||
        item.cycles < 0 ||
        !Array.isArray(item.history)
      )
        throw Error('PROACTIVE_STATE_INVALID');
    for (const [key, item] of Object.entries(this.state.chats)) {
      if (
        item.history.length > 12 ||
        item.history.some(
          entry => !entry || typeof entry.text !== 'string' || entry.text.length > 1200 || !Number.isFinite(entry.at),
        )
      )
        throw Error('PROACTIVE_STATE_INVALID');
      const job = item.job;
      if (!job) continue;
      if (
        !/^[a-f0-9]{64}$/.test(job.id ?? '') ||
        !Number.isFinite(job.createdAt) ||
        !Number.isFinite(job.expiresAt) ||
        job.expiresAt - job.createdAt > draftLifetimeMs ||
        !/^[a-f0-9]{64}$/.test(job.snapshot ?? '') ||
        (job.observeOnly !== undefined && (job.observeOnly !== true || !job.dispatching)) ||
        (job.retiredAt !== undefined && (!Number.isSafeInteger(job.retiredAt) || job.retiredAt < 1)) ||
        (!job.evaluating &&
          (typeof job.text !== 'string' ||
            job.text.length > 1200 ||
            !job.message ||
            buildConversationKey(job.message.platform, job.message.kind, job.message.conversation_id) !== key))
      )
        throw Error('PROACTIVE_STATE_INVALID');
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temp = this.stateFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temp, this.stateFile);
  }
  eligible(key, policy, now) {
    return (
      policy.enabled &&
      withinProactiveWindow(now, policy) &&
      this.social.deliveryControls?.scope(key) !== null &&
      !this.taskContext?.social.running.has(key) &&
      [this, this.taskContext].every(context => {
        if (!context) return true;
        const { buffer, social } = context;
        const rows = buffer.recent(key, buffer.maxPerChat);
        const last = rows.at(-1)?.timestamp * 1000 || 0;
        return (
          !social.unreadFor(key, 1).length &&
          !buffer.pendingReplies.has(key) &&
          !buffer.pendingRequests?.has(key) &&
          ![...buffer.mediaReplies.values()].some(item => item.key === key && item.observeOnly !== true) &&
          now - last >= policy.idleMinutes * 60000 &&
          !declinedProactive(rows) &&
          rows.at(-1)?.delivery_status !== 'unconfirmed'
        );
      })
    );
  }
  #snapshot(key, rows = this.buffer.recent(key, this.buffer.maxPerChat)) {
    const tasks = this.taskContext?.buffer;
    return conversationSnapshot(rows, tasks?.recent(key, tasks.maxPerChat));
  }
  #sameContext(key, item, policy, now) {
    return (
      proactivePolicyKey(policy) === item.signature &&
      this.eligible(key, policy, now) &&
      this.#snapshot(key) === item.job.snapshot
    );
  }
  #retire(key, item) {
    const { job } = item;
    if (job.observeOnly) return;
    this.social.deliveryControls?.withdrawInputs(key, job.message.readerGrant ?? 'legacy', [job.id]);
    job.observeOnly = true;
    job.retiredAt = this.now();
    try {
      this.save();
    } catch (error) {
      delete job.observeOnly;
      delete job.retiredAt;
      throw error;
    }
  }
  #checkReceipt(key, item) {
    const job = item.job;
    if (!job || this.receiptChecks.has(job.id)) return;
    this.receiptChecks.add(job.id);
    // Keep recovered work within one receipt slot without holding the scheduler.
    const check = this.receiptWork.then(async () => {
      try {
        if (item.job === job) await this.deliver(key, item, true);
      } finally {
        this.receiptChecks.delete(job.id);
      }
    });
    this.receiptWork = check.catch(() => {});
    return check;
  }
  notice(key, id) {
    this.buffer.setContextNotice(key, {
      id,
      text: '本机上一轮主动发言草稿已取消，未确认提交到微信；不能将原生会话中的那段草稿当成已经说过的话。',
    });
  }
  finishRecorded(key, item) {
    const job = item?.job;
    if (!job) return false;
    const row = this.buffer.recent(key, this.buffer.maxPerChat).find(entry => entry.delivery_id === job.id);
    if (!row) return false;
    if (!item.history.some(entry => entry.deliveryId === job.id))
      item.history.push({
        at: row.timestamp * 1000,
        text: row.text,
        mode: job.mode,
        topicDigest: job.topicDigest,
        deliveryId: job.id,
      });
    item.history = item.history.slice(-12);
    item.job = null;
    this.save();
    return true;
  }
  async tick() {
    if (this.busy || !this.isReady()) return;
    this.busy = true;
    const receipts = [];
    try {
      const settings = await this.settingsFor(),
        wechat = settings.wechat ?? settings;
      const keys = new Set(
        ['private', 'group'].flatMap(kind =>
          (wechat.whitelist?.[kind === 'private' ? 'private' : 'groups'] ?? []).map(id =>
            buildConversationKey('wechat', kind, String(id)),
          ),
        ),
      );
      for (const [key, item] of Object.entries(this.state.chats)) if (item.job?.dispatching) keys.add(key);
      for (const key of keys) {
        const policy = proactivePolicy(wechat, key, !!this.taskContext);
        let item = this.state.chats[key];
        const now = this.now(),
          signature = proactivePolicyKey(policy);
        if (this.finishRecorded(key, item)) continue;
        const rosterGrant = conversationGrant(wechat, key);
        const maySchedule = rosterGrant !== null;
        const job = item?.job;
        const expired = job && now >= job.expiresAt;
        if (
          job?.dispatching &&
          (job.observeOnly ||
            !maySchedule ||
            !policy.enabled ||
            expired ||
            job.message.readerGrant !== rosterGrant ||
            this.social.deliveryControls?.inputWithdrawn(key, job.message.readerGrant ?? 'legacy', job.id))
        ) {
          this.#retire(key, item);
          receipts.push([key, item]);
          continue;
        }
        if (job && this.receiptChecks.has(job.id)) continue;
        if (!maySchedule) continue;
        if (!policy.enabled) {
          if (item && item.signature !== signature) {
            if (item.job && !item.job.dispatching) {
              this.notice(key, item.job.id);
              item.job = null;
            }
            item.signature = signature;
            this.save();
          }
          continue;
        }
        if (!item) {
          item = this.state.chats[key] = {
            nextAt: nextProactiveAt(now, policy, this.random),
            cycles: 0,
            history: [],
            signature,
          };
          this.save();
          continue;
        }
        if (item.signature !== signature && !item.job?.dispatching) {
          item.signature = signature;
          item.nextAt = nextProactiveAt(now, policy, this.random);
          item.job = null;
          this.save();
          continue;
        }
        if (item.job?.evaluating) {
          this.notice(key, item.job.id);
          item.job = null;
          item.nextAt = nextProactiveAt(now, policy, this.random);
          this.save();
          continue;
        }
        if (expired) {
          this.notice(key, item.job.id);
          item.job = null;
          item.nextAt = nextProactiveAt(now, policy, this.random);
          this.save();
          continue;
        }
        if (!item.job && (now < item.nextAt || !this.eligible(key, policy, now))) continue;
        const ran = await this.social.withConversationLock(key, () => this.run(key, policy, item, rosterGrant));
        if (item.job?.dispatching && (!ran || item.job.observeOnly)) {
          if (!ran && !this.#sameContext(key, item, policy, this.now())) this.#retire(key, item);
          receipts.push([key, item]);
        }
      }
    } catch (error) {
      this.log('[Proactive] unavailable ' + String(error.message));
    } finally {
      this.busy = false;
    }
    const observed = await Promise.allSettled(receipts.map(([key, item]) => this.#checkReceipt(key, item)));
    for (const result of observed)
      if (result.status === 'rejected')
        this.log('[Proactive] receipt recovery unavailable ' + String(result.reason?.code ?? 'unknown'));
  }
  async run(key, policy, item, rosterGrant) {
    const connection = this.social.connection;
    const signal = connection?.signal;
    const decide = (chat, prompt, metadata) =>
      signal
        ? boundedTask(current => this.decide(chat, prompt, metadata, { signal: current }), { signal })
        : this.decide(chat, prompt, metadata);
    const target = parseConversationKey(key),
      rows = this.buffer.recent(key, this.buffer.maxPerChat),
      persona = await this.personaFor(key);
    const message = {
      platform: 'wechat',
      kind: target.kind,
      conversation_id: target.conversationId,
      conversation_name: rows.at(-1)?.conversation_name ?? target.conversationId,
      readerGrant: rosterGrant,
      self_id: String(this.selfIdFor() || rows.at(-1)?.self_id || ''),
      sender_id: 'local-scheduler',
      sender_name: '本机主动发言',
      ...(this.taskContext ? { work_mode: 'assistant', assistant_chat_only: true } : {}),
    };
    if (!message.self_id) return;
    let job = item.job;
    if (!job) {
      const mode = policy.mode === 'mixed' ? ['greeting', 'news', 'meme'][item.cycles % 3] : policy.mode;
      const createdAt = this.now();
      job = item.job = {
        id: hash(key + (this.taskContext ? ':assistant-chat' : '') + '\0' + item.nextAt + '\0' + item.cycles),
        mode,
        createdAt,
        expiresAt: createdAt + draftLifetimeMs,
        snapshot: this.#snapshot(key, rows),
        personaDigest: hash(JSON.stringify([persona.personaName, persona.persona])),
        evaluating: true,
      };
      item.cycles++;
      item.nextAt = nextProactiveAt(createdAt, policy, this.random);
      this.save();
      let search = null;
      if (mode !== 'greeting' && policy.useSearch) {
        const day = localTime(this.now()).slice(0, 10),
          query = mode === 'meme' ? `帮我搜索 ${day} 最近热门 新梗 meme 含义` : `帮我搜索 ${day} 最新 热点 新闻`;
        try {
          search = await this.searchFor(message, [{ text: query }], job.id);
        } catch {
          search = { status: 'unavailable' };
        }
      }
      const metadata = {
        persona: persona.persona,
        personaName: persona.personaName,
        conversationName: message.conversation_name,
        images: [],
        batchId: job.id,
        ...connection?.metadata(),
        rosterGrant,
        ...(this.taskContext ? { workMode: 'assistant', assistantChatOnly: true, scheduledChat: true } : {}),
        searchOptOut: mode === 'greeting' || !policy.useSearch || search?.status === 'unavailable',
      };
      if (search?.status === 'ready') {
        metadata.searchTicket = search.id;
        metadata.searchContext = search.context;
        job.topicDigest = hash(search.context.slice(Math.max(0, search.context.indexOf('\n1.'))));
      }
      if (
        job.topicDigest &&
        item.history.some(entry => entry.topicDigest === job.topicDigest && this.now() - entry.at < 7 * 86400000)
      ) {
        delete metadata.searchTicket;
        delete metadata.searchContext;
        delete job.topicDigest;
        search = null;
        job.mode = 'greeting';
      }
      const notice = this.buffer.contextNotices.get(key);
      const prompt =
        buildProactivePrompt({
          key,
          rows: this.historyFor?.(key, rosterGrant) ?? rows,
          mode: job.mode,
          now: this.now(),
          searchStatus: search?.status,
          recentTopics: item.history,
        }) + (notice ? '\n本机发送状态说明：' + quote(notice.text) : '');
      job.noticeId = notice?.id;
      metadata.memeLibraryDisabled = true; // This public scheduler keeps its existing text-only contract.
      let result;
      try {
        ({ result } = await resolveSocialDecision({
          rawOutput: await decide(key, prompt, metadata),
          key,
          metadata,
          decide,
          log: this.log,
        }));
        signal?.throwIfAborted();
      } catch (error) {
        if (!signal?.aborted) this.notice(key, job.id);
        item.job = null;
        this.save();
        this.log(`[Proactive] ${key} decision_failed`);
        return;
      }
      if (
        result.decision !== 'RESPOND' ||
        item.history.some(entry => entry.text.trim() === result.text.trim() && this.now() - entry.at < 86400000)
      ) {
        if (result.decision === 'RESPOND') this.notice(key, job.id);
        item.job = null;
        this.save();
        this.log(`[Proactive] ${key} skipped decision=${result.decision}`);
        return;
      }
      Object.assign(job, { evaluating: false, text: result.text, message });
      this.save();
    }
    if (this.finishRecorded(key, item)) return;
    if (
      [job.text, ...(job.textParts ?? [])].some(
        text => hasStickerControl(text) || hasReasoningControl(text) || hasReplyProtocolControl(text),
      )
    ) {
      this.notice(key, job.id);
      item.job = null;
      this.save();
      this.log(`[Proactive] ${key} skipped invalid_sticker_reference`);
      return;
    }
    const fresh = await this.settingsFor(),
      wechat = fresh.wechat ?? fresh,
      current = proactivePolicy(wechat, key, !!this.taskContext),
      livePersona = await this.personaFor(key);
    if (
      signal?.aborted ||
      conversationGrant(wechat, key) !== job.message.readerGrant ||
      this.now() >= job.expiresAt ||
      !this.#sameContext(key, item, current, this.now()) ||
      hash(JSON.stringify([livePersona.personaName, livePersona.persona])) !== job.personaDigest
    ) {
      if (job.dispatching) {
        this.#retire(key, item);
        return;
      }
      this.notice(key, job.id);
      item.job = null;
      this.save();
      this.log(`[Proactive] ${key} cancelled_context_changed`);
      return;
    }
    if (!job.dispatching) {
      job.dispatching = true;
      this.save();
    }
    return this.deliver(key, item);
  }

  async deliver(key, item, observeOnly = false) {
    const { job } = item;
    let delivery;
    try {
      const send = () =>
        this.send(job.message, job.text, {
          deliveryId: job.id,
          source: 'proactive',
          contextId: job.snapshot,
          expiresAt: job.expiresAt,
          receiptOnly: observeOnly || job.awaitingReceipt === true,
          observeOnly,
        });
      delivery = observeOnly
        ? await boundedTask(send, {
            timeoutMs: this.social.deliveryRetry?.mediaCallTimeoutMs ?? 10000,
            code: 'PROACTIVE_RECEIPT_TIMEOUT',
          })
        : await send();
    } catch (error) {
      if (
        ['PROACTIVE_NOT_ALLOWED', 'PROACTIVE_CONTEXT_CHANGED', 'CONVERSATION_NOT_ALLOWED'].includes(error.code) ||
        (error.code === 'NATIVE_SEND_REJECTED' && error.data?.attempted === false)
      ) {
        this.notice(key, job.id);
        item.job = null;
      }
      this.save();
      this.log(`[Proactive] ${key} send_pending code=${error.code ?? 'unknown'}`);
      return;
    }
    const outcome = replyDeliveryStatus(delivery);
    if (outcome === 'pending') {
      if (!job.awaitingReceipt) {
        job.awaitingReceipt = true;
        this.save();
      }
      return;
    }
    const status = outcome === 'confirmed' ? 'confirmed' : 'unconfirmed';
    const fallback = job.retiredAt ?? this.now();
    const at = status === 'confirmed' ? replySentAt(delivery, fallback) : fallback;
    this.buffer.recordReplyPart(
      key,
      { deliveryId: job.id, noticeId: job.noticeId },
      {
        ...job.message,
        sender_id: job.message.self_id,
        text: job.text,
        timestamp: at / 1000,
        delivery_status: status,
        proactive: true,
      },
      {
        inSendOrder: job.observeOnly === true || (status === 'confirmed' && delivery.sentAt === at),
        receiptOrder: delivery?.readerOrder,
      },
    );
    this.social.noteOutgoing(key, at);
    item.history.push({ at, text: job.text, mode: job.mode, topicDigest: job.topicDigest, deliveryId: job.id });
    item.history = item.history.slice(-12);
    item.job = null;
    this.save();
    this.log(`[Proactive] ${key} delivery=${status} mode=${job.mode}`);
  }
}
