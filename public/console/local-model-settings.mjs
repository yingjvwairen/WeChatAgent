// Process lifecycle is host-owned; API providers and per-chat grants remain in the plugins.
import { MODEL_FIELDS, VOICE_PARAMETERS, modelDefaults, createLocalModelDrafts } from './local-model-schema.mjs';
const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function localModelSettings({ field, toggle }) {
  const processSettings = (label, key, rows) =>
    `<div class="form-grid">${toggle(label, 'runtime.localSpeech.' + key + '.enabled', '保存后随桌面应用预热；机器人也可独立持有服务。')}${rows.map(([name, setting, options]) => field(name, 'runtime.localSpeech.' + key + '.' + setting, options)).join('')}</div>`;
  const recognition = processSettings('预热本地语音识别', 'asr', [
    ['识别 Python', 'python', { browse: 'exe' }],
    ['识别模型/扫描目录', 'modelDirectory', { browse: 'folder' }],
    ['识别端口（默认 8000）', 'port', { type: 'number', min: 1024, max: 65535 }],
    ['识别方案文件（留空由界面管理）', 'profiles', {}],
  ]);
  const synthesis = processSettings('预热本地语音合成', 'tts', [
    ['合成 Python', 'python', { browse: 'exe' }],
    ['GPT-SoVITS 安装目录', 'modelDirectory', { browse: 'folder' }],
    ['合成端口（默认 9881）', 'port', { type: 'number', min: 1024, max: 65535 }],
    ['合成方案文件（留空由界面管理）', 'profiles', {}],
  ]);
  return `<section class="card" data-local-model-settings><details><summary>本地语音服务与模型方案</summary><p>应用启动后自动预热已启用的服务。“保存并使用”立即加载权重，等待加载完成后再显示已就绪。关闭桌面或机器人时，其他仍在运行的使用者会继续保留服务。云端提供商与聊天授权仍在语音插件里设置。</p>${recognition}<div data-model-editor="asr">正在读取识别方案…</div>${synthesis}<div data-model-editor="tts">正在读取音色方案…</div><p>本地插件的模型名填 <code>default</code>，即可跟随这里选择的方案；填写具体方案 ID 时固定使用该方案。先保存解释器、端口与安装目录，再扫描和编辑方案。保存端口或模型目录后，相应的本地语音服务会重新启动。</p></details></section>`;
}

export function profileEditorHtml(kind, state, id, profile, candidates = {}) {
  const selected = state.selectedProfile;
  const editorFields = MODEL_FIELDS[kind]
    .map(field => {
      const { key, label, multiline, min, max, integer } = field;
      const value = profile[key] ?? field.default ?? '';
      const control = multiline
        ? `<textarea data-model-field="${key}">${esc(value)}</textarea>`
        : `<input data-model-field="${key}" ${min !== undefined ? `type="number" min="${min}" max="${max}" step="${integer ? '1' : 'any'}"` : ''} value="${esc(value)}" ${candidates[key]?.length ? `list="local-${kind}-${key}"` : ''}>`;
      const suggestions = candidates[key]?.length
        ? `<datalist id="local-${kind}-${key}">${candidates[key].map(item => `<option value="${esc(item)}"></option>`).join('')}</datalist>`
        : '';
      return `<label>${esc(label)}${control}${suggestions}</label>`;
    })
    .join('');
  const cannotDelete = id === selected || !Object.hasOwn(state.profiles, id) || Object.keys(state.profiles).length <= 1;
  return `<h3>${kind === 'asr' ? '识别方案' : '音色方案'}</h3><div class="form-grid"><label>已有方案<select data-model-select><option value="">新增方案</option>${Object.entries(
    state.profiles,
  )
    .map(
      ([key, row]) =>
        `<option value="${esc(key)}" ${key === id ? 'selected' : ''}>${esc(row.name || key)}${key === selected ? ' · 已选中' : ''}</option>`,
    )
    .join(
      '',
    )}</select></label><label>方案 ID<input data-model-id value="${esc(id)}" ${Object.hasOwn(state.profiles, id) ? 'readonly' : ''} placeholder="${kind === 'asr' ? 'chinese' : 'dania'}"></label>${editorFields}</div><div class="modal-actions"><button type="button" class="button" data-model-action="scan">扫描本机模型</button><button type="button" class="button" data-model-action="save">保存方案</button><button type="button" class="button primary" data-model-action="use">保存并使用</button><button type="button" class="button" data-model-action="discard">放弃修改</button><button type="button" class="button" data-model-action="delete" ${cannotDelete ? 'disabled' : ''}>删除方案</button></div><p data-model-status role="status">${selected ? `已选择：${esc(state.profiles[selected]?.name || selected)}` : '尚未选择方案'}。</p><p class="subtle">删除当前方案前，请先保存并使用另一个方案。</p><p class="subtle" data-model-process-status></p><p class="subtle">插件地址：${esc(state.endpoint)}；API 密钥保存在 ${esc(state.apiKeyFile)}。</p>`;
}

export async function bindLocalModelSettings({
  container,
  api,
  drafts = createLocalModelDrafts(),
  onError = () => {},
}) {
  const panels = [...container.querySelectorAll('[data-model-editor]')];
  if (!panels.length) return;
  let data;
  try {
    data = await api('/api/local-models');
  } catch (error) {
    panels.forEach(panel => {
      panel.textContent = error.message;
    });
    onError(error);
    return;
  }
  const updateProcessStatus = result => {
    for (const panel of panels) {
      const status = panel.querySelector('[data-model-process-status]');
      const model = result[panel.dataset.modelEditor];
      if (status && model)
        status.textContent =
          '后台服务：' +
          ({
            ready: model?.loadedProfile ? '已加载 ' + model.loadedProfile : '已就绪',
            saved: '新设置已保存，后台仍使用上次加载的设置。选择“保存并使用”应用更改。',
            starting: '正在预热',
            loading: '正在加载模型',
            failed: '模型加载失败，请检查环境和模型路径',
            unavailable: '暂时无法确认模型状态',
            standby: '当前聊天使用云端服务，本机模型已释放',
            stopped: '未启动',
          }[model?.phase] || '未启动');
    }
  };
  if (!panels.some(panel => panel.isConnected)) return;
  let polling = false;
  const timer = setInterval(async () => {
    if (!panels.some(panel => panel.isConnected)) {
      clearInterval(timer);
      return;
    }
    if (polling) return;
    polling = true;
    try {
      updateProcessStatus(await api('/api/local-models'));
    } catch {
    } finally {
      polling = false;
    }
  }, 3000);
  for (const panel of panels) {
    if (!panel.isConnected) continue;
    const kind = panel.dataset.modelEditor;
    let saved = drafts.get(kind)?.saved ?? data[kind],
      selected = drafts.get(kind)?.id ?? saved.selectedProfile ?? Object.keys(saved.profiles)[0] ?? '',
      candidates = {},
      busy = false;
    const paint = () => {
      const draft = drafts.get(kind);
      panel.innerHTML = profileEditorHtml(
        kind,
        saved,
        draft?.id ?? selected,
        draft?.profile ?? saved.profiles[selected] ?? modelDefaults(kind),
        candidates,
      );
      if (draft) panel.querySelector('[data-model-status]').textContent = '有未保存的方案修改，切换页面会保留草稿。';
      updateProcessStatus({ [kind]: saved });
    };
    const collect = () =>
      Object.fromEntries(
        [...panel.querySelectorAll('[data-model-field]')].map(input => [
          input.dataset.modelField,
          Object.hasOwn(VOICE_PARAMETERS, input.dataset.modelField) ? Number(input.value) : input.value,
        ]),
      );
    paint();
    updateProcessStatus(data);
    panel.addEventListener('input', event => {
      if (busy || !event.target.matches('[data-model-field], [data-model-id]')) return;
      drafts.set(kind, {
        id: panel.querySelector('[data-model-id]').value.trim(),
        profile: collect(),
        saved,
      });
      panel.querySelector('[data-model-status]').textContent = '有未保存的方案修改。';
    });
    panel.addEventListener('change', event => {
      if (!event.target.matches('[data-model-select]') || busy) return;
      if (drafts.get(kind)) {
        event.target.value = selected;
        onError(Error('请先保存或放弃当前方案的修改，再选择其他方案。'));
        return;
      }
      selected = event.target.value;
      paint();
    });
    panel.addEventListener('click', async event => {
      const button = event.target.closest('[data-model-action]');
      if (!button || button.disabled || busy) return;
      event.preventDefault();
      const status = panel.querySelector('[data-model-status]'),
        action = button.dataset.modelAction;
      if (action === 'discard') {
        drafts.clear(kind);
        paint();
        return;
      }
      busy = true;
      panel.querySelectorAll('button,input,textarea,select').forEach(input => {
        input.disabled = true;
      });
      status.textContent = action === 'use' ? '正在保存并加载模型，请等待加载完成…' : '正在处理…';
      try {
        const id = panel.querySelector('[data-model-id]').value.trim(),
          profile = collect();
        if (action === 'scan') {
          const result = await api('/api/local-models/discover', { kind });
          candidates = result.candidates;
          // Keep unsaved fields while adding the scanner's native datalist suggestions.
          panel.innerHTML = profileEditorHtml(kind, saved, id, profile, candidates);
          panel.querySelector('[data-model-status]').textContent = result.truncated
            ? '扫描达到数量上限；可手动填写其余路径。'
            : '扫描完成，模型路径输入框可选择扫描结果。';
        } else {
          const profiles = { ...saved.profiles };
          if (action === 'delete') delete profiles[id];
          else profiles[id] = profile;
          let result = await api('/api/local-models/profiles', { kind, profiles, revision: saved.revision });
          saved = result[kind];
          selected = action === 'delete' ? Object.keys(saved.profiles)[0] || '' : id;
          drafts.clear(kind);
          if (action === 'use') {
            result = await api('/api/local-models/use', { kind, profile: id, revision: saved.revision });
            saved = result[kind];
          }
          if (panel.isConnected) {
            paint();
            panel.querySelector('[data-model-status]').textContent =
              action !== 'use'
                ? '方案已保存。'
                : result.loaded?.phase === 'standby'
                  ? `已选定本机方案，切回本机${kind === 'asr' ? '识别' : '合成'}时加载。`
                  : '模型已加载，可以立即使用。';
          }
        }
      } catch (error) {
        if (panel.isConnected) panel.querySelector('[data-model-status]').textContent = error.message;
        onError(error);
        if (action === 'use') updateProcessStatus(await api('/api/local-models').catch(() => ({})));
      } finally {
        busy = false;
        if (panel.isConnected) {
          panel.querySelectorAll('button,input,textarea,select').forEach(input => {
            input.disabled = false;
          });
          const remove = panel.querySelector('[data-model-action="delete"]');
          if (remove)
            remove.disabled =
              selected === saved.selectedProfile ||
              Object.keys(saved.profiles).length <= 1 ||
              !Object.hasOwn(saved.profiles, selected);
        }
      }
    });
  }
}
