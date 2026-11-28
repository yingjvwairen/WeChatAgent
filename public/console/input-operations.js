const phases = {
  'contact-navigation': '切换联系人',
  preparation: '准备与输入',
  'record-start': '开始录音',
  'record-submit': '发送语音',
  'record-cancel': '取消录音',
  navigation: '切换联系人',
  text: '输入与发送',
  submit: '提交消息',
};
const seconds = value => (Number.isFinite(value) && value >= 0 ? (value / 1000).toFixed(3) + ' 秒' : '未测量');
const operationNames = { text: '文字', voice: '语音', image: '图片', gif: 'GIF', file: '文件', quote: '引用' };

export function timingMarkup(measurements, esc) {
  if (!measurements?.length) return '<p class="subtle">暂无前台占用记录。</p>';
  return measurements
    .map(
      row =>
        `<article class="timing-record"><p><strong>${esc(operationNames[row.operation] ?? '桌面操作')}</strong> · ${row.complete ? '最长一次 ' + seconds(row.maxContinuousForegroundMs) : '记录不完整'}${row.includesContactNavigation ? '（含联系人切换）' : ''}</p><ul>${(row.intervals ?? []).map(interval => `<li>${esc(phases[interval.phase] ?? '前台阶段')} · ${seconds(interval.durationMs)}${interval.complete === false ? '（记录不完整）' : ''}</li>`).join('')}</ul></article>`,
    )
    .join('');
}

export function recoveryMarkup(items, esc) {
  if (!items?.length) return '<p class="subtle">没有需要人工处理的草稿或录音占用。</p>';
  return items
    .map(
      item =>
        `<article class="notice plain" data-input-recovery="${esc(item.id)}"><div><strong>${item.focusRecoveryRequired ? '窗口焦点待恢复' : item.kind === 'recording' ? '录音占用待核对' : '草稿待核对'}</strong><p>${esc(item.message ?? item.reason ?? '请检查微信中的残留输入及对应消息结果。')}</p>${item.canRecover ? `<label class="toggle-row"><span>${item.focusRecoveryRequired ? '我已确认微信窗口及键盘焦点正常。' : item.kind === 'recording' ? '我已确认录音结束，录音界面已关闭。' : '我已处理对应聊天输入框中的草稿和引用。'}</span><input type="checkbox" data-operation-ack="${item.kind === 'recording' ? 'recording' : 'draft'}"></label><label class="toggle-row"><span>我已核对对应聊天的消息结果。</span><input type="checkbox" data-operation-ack="outcome"></label><button class="button" data-operation-recover="${esc(item.id)}">解除这次占用</button>` : '<p>停止后台发送服务并检查微信后，刷新这里继续处理。</p>'}</div></article>`,
    )
    .join('');
}

export function createInputOperationsUI({
  api,
  escapeHtml: esc,
  toast,
  query = selector => document.querySelector(selector),
}) {
  let state,
    loading = false,
    recovering = false,
    signature;
  const placeholder = () =>
    `<section class="card" id="input-operations"><div class="card-heading"><h2>前台占用与操作恢复</h2><button class="button" data-input-operations-refresh>刷新记录</button></div><p class="subtle">按每一次连续借用前台分别计时，包含联系人切换；恢复只解除已核对的占用，不启动服务，也不重发或确认旧消息。</p><p data-input-configuration role="status"></p><button class="button" data-input-configuration-apply hidden>重新应用已保存的电脑设置</button><h3>最近一次连续前台占用</h3><div data-input-timing role="status">正在读取…</div><h3>需要人工处理</h3><div data-input-recoveries role="status">正在读取…</div><p data-input-operation-error class="inline-error" role="alert"></p></section>`;
  function paint(host, data) {
    state = data;
    host.querySelector('[data-input-timing]').innerHTML = timingMarkup(data.measurements, esc);
    const configuration = data.configuration;
    host.querySelector('[data-input-configuration]').textContent = configuration?.error
      ? '电脑设置尚未应用，请处理当前输入后重试。'
      : configuration?.pending
        ? '电脑设置已保存，正在等待当前输入结束；暂停中的任务可在聊天发送队列继续。'
        : configuration?.available
          ? '当前电脑设置已应用。'
          : '';
    host.querySelector('[data-input-configuration-apply]').hidden = !configuration?.error;
    const current = JSON.stringify([data.account, data.recoveries]);
    if (current !== signature) {
      host.querySelector('[data-input-recoveries]').innerHTML = recoveryMarkup(data.recoveries, esc);
      signature = current;
    }
    host.querySelector('[data-input-operation-error]').textContent = '';
  }
  async function refresh() {
    const host = query('#input-operations');
    if (!host || loading || recovering) return;
    loading = true;
    try {
      const data = await api('/api/input-operations');
      if (host.isConnected) paint(host, data);
    } catch (error) {
      if (host.isConnected) host.querySelector('[data-input-operation-error]').textContent = error.message;
    } finally {
      loading = false;
    }
  }
  function mount() {
    const host = query('#input-operations');
    if (!host) return;
    signature = undefined;
    host.addEventListener('click', async event => {
      if (event.target.closest('[data-input-operations-refresh]')) return refresh();
      if (event.target.closest('[data-input-configuration-apply]')) {
        try {
          await api('/api/desktop/apply', {});
          await refresh();
        } catch (error) {
          toast(error.message);
        }
        return;
      }
      const button = event.target.closest('[data-operation-recover]');
      if (!button || recovering) return;
      const item = state?.recoveries?.find(row => row.id === button.dataset.operationRecover);
      if (!item?.canRecover) return;
      const row = button.closest('[data-input-recovery]');
      const acknowledged = name => row.querySelector(`[data-operation-ack="${name}"]`)?.checked === true;
      if (!acknowledged(item.kind === 'recording' ? 'recording' : 'draft') || !acknowledged('outcome'))
        return toast('请先完成检查并勾选确认。');
      recovering = true;
      button.disabled = true;
      try {
        const data = await api('/api/input-operations/recover', {
          account: state.account,
          id: item.id,
          revision: item.revision,
          acknowledgeDraftCleared: item.kind !== 'recording',
          acknowledgeRecordingEnded: item.kind === 'recording',
          acknowledgeOutcomeReviewed: true,
        });
        if (host.isConnected) paint(host, data);
        toast('本次占用已解除；原消息不会自动重发。');
      } catch (error) {
        if (host.isConnected) host.querySelector('[data-input-operation-error]').textContent = error.message;
      } finally {
        recovering = false;
        if (button.isConnected) button.disabled = false;
      }
    });
    void refresh();
  }
  return { placeholder, mount, refresh };
}
