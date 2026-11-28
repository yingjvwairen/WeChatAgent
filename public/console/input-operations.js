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
  if (!items?.length) return '<p class="subtle">暂无待处理操作。</p>';
  return items
    .map(item => {
      const recording = item.kind === 'recording';
      const title = item.focusRecoveryRequired ? '窗口焦点待恢复' : recording ? '录音待核对' : '草稿待核对';
      const checked = item.focusRecoveryRequired
        ? '微信窗口及键盘焦点正常'
        : recording
          ? '录音已结束，录音界面已关闭'
          : '已处理聊天输入框里的草稿和引用';
      const context = item.message ? `<p class="subtle">${esc(item.message)}</p>` : '';
      return `<article class="input-recovery-card" data-input-recovery="${esc(item.id)}">
        <h3>${title}</h3>
        ${context}
        ${
          item.canRecover
            ? `<div class="input-recovery-checks">
            <label><input type="checkbox" data-operation-ack="${recording ? 'recording' : 'draft'}">${checked}</label>
            <label><input type="checkbox" data-operation-ack="outcome">已核对该聊天的消息结果</label>
          </div><div class="button-row"><button class="button" data-operation-recover="${esc(item.id)}" disabled>解除占用</button></div>`
            : '<p class="subtle">停止后台发送服务后刷新记录。</p>'
        }
        ${item.reason ? `<details class="input-recovery-detail"><summary>错误详情</summary><code>${esc(item.reason)}</code></details>` : ''}
      </article>`;
    })
    .join('');
}

export function createInputOperationsUI({
  api,
  escapeHtml: esc,
  header,
  toast,
  query = selector => document.querySelector(selector),
}) {
  let state,
    loading,
    recovering = false,
    recoverySignature,
    timingSignature;
  const placeholder = () =>
    `<section class="card" id="input-operations">
      ${header('发送操作恢复', '', '<button class="button" data-input-operations-refresh>刷新记录</button>', 'tool')}
      <div class="notice" data-input-configuration-panel hidden><span data-input-configuration role="status"></span><button class="button" data-input-configuration-apply hidden>重新应用</button></div>
      <p class="subtle input-recovery-guide" data-input-recovery-guide hidden>请先停止服务，再到微信核对。</p>
      <div class="input-recovery-list" data-input-recoveries>正在读取…</div>
      <details class="advanced"><summary>最近的前台占用记录</summary><div class="input-timing-list" data-input-timing>正在读取…</div></details>
      <p data-input-operation-error class="inline-error" role="alert"></p>
    </section>`;
  function paint(host, data) {
    state = data;
    const timing = JSON.stringify(data.measurements ?? []);
    if (timing !== timingSignature) {
      host.querySelector('[data-input-timing]').innerHTML = timingMarkup(data.measurements, esc);
      timingSignature = timing;
    }
    const configuration = data.configuration;
    host.querySelector('[data-input-configuration-panel]').hidden = !configuration?.error && !configuration?.pending;
    host.querySelector('[data-input-configuration]').textContent = configuration?.error
      ? '发送设置尚未应用。'
      : '已保存的发送设置将在当前输入结束后应用。';
    host.querySelector('[data-input-configuration-apply]').hidden = !configuration?.error;
    const recovery = JSON.stringify([data.account, data.recoveries]);
    if (recovery !== recoverySignature) {
      host.querySelector('[data-input-recoveries]').innerHTML = recoveryMarkup(data.recoveries, esc);
      host.querySelector('[data-input-recovery-guide]').hidden = !data.recoveries?.some(item => item.canRecover);
      recoverySignature = recovery;
    }
    host.querySelector('[data-input-operation-error]').textContent = '';
  }
  async function refresh() {
    const host = query('#input-operations');
    if (!host || loading?.host === host || recovering) return;
    const pending = { host };
    loading = pending;
    try {
      const data = await api('/api/input-operations');
      if (loading === pending && host.isConnected) paint(host, data);
    } catch (error) {
      if (loading === pending && host.isConnected)
        host.querySelector('[data-input-operation-error]').textContent = error.message;
    } finally {
      if (loading === pending) loading = undefined;
    }
  }
  function mount() {
    const host = query('#input-operations');
    if (!host) return;
    recoverySignature = timingSignature = undefined;
    const ready = row =>
      row.querySelector('[data-operation-ack="outcome"]').checked &&
      row.querySelector('[data-operation-ack]:not([data-operation-ack="outcome"])').checked;
    host.addEventListener('change', event => {
      if (!event.target.matches('[data-operation-ack]')) return;
      const row = event.target.closest('[data-input-recovery]');
      row.querySelector('[data-operation-recover]').disabled = !ready(row);
    });
    host.addEventListener('click', async event => {
      if (event.target.closest('[data-input-operations-refresh]')) return refresh();
      const apply = event.target.closest('[data-input-configuration-apply]');
      if (apply) {
        apply.disabled = true;
        try {
          await api('/api/desktop/apply', {});
          await refresh();
        } catch (error) {
          toast(error.message);
        } finally {
          apply.disabled = false;
        }
        return;
      }
      const button = event.target.closest('[data-operation-recover]');
      if (!button || recovering) return;
      const item = state?.recoveries?.find(row => row.id === button.dataset.operationRecover);
      if (!item?.canRecover) return;
      const row = button.closest('[data-input-recovery]');
      if (!ready(row)) return;
      recovering = true;
      loading = undefined;
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
        if (host.isConnected) paint(host, { ...data, configuration: state.configuration });
        toast('本次操作占用已解除。');
      } catch (error) {
        if (host.isConnected) host.querySelector('[data-input-operation-error]').textContent = error.message;
      } finally {
        recovering = false;
        if (button.isConnected) button.disabled = !ready(row);
      }
    });
    void refresh();
  }
  return { placeholder, mount, refresh };
}
