// Process lifecycle is host-owned; API providers and per-chat grants remain in the plugins.
import { MODEL_FIELDS, VOICE_PARAMETERS, modelDefaults, createLocalModelDrafts } from './local-model-schema.mjs';
const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export const VOICE_PLUGIN = 'speech-synthesis';
export const LEGACY_RECOGNIZER = 'speech-recognition';

const voicePluginState = item =>
  item.invalid
    ? '<span class="status-tag error">无法读取</span>'
    : `<span class="status-tag ${esc(item.statusTone)}">${esc(item.statusLabel)}</span>`;

export function voiceSettings({ catalog, header, field, toggle }) {
  const primary = catalog.plugins?.find(item => item.id === VOICE_PLUGIN);
  const legacy = catalog.plugins?.find(item => item.id === LEGACY_RECOGNIZER);
  const pluginError = catalog.error ? `<p class="inline-error" role="alert">${esc(catalog.error)}</p>` : '';
  const actions = primary
    ? `<div class="button-row"><button class="button primary" data-plugin-settings="${VOICE_PLUGIN}">配置语音与聊天授权</button>${!primary.builtin ? `<button class="button danger" data-plugin-uninstall="${VOICE_PLUGIN}">卸载</button>` : ''}</div>`
    : '<div class="button-row"><button class="button" data-plugin-install>安装语音对话插件 ZIP</button></div>';
  return `<section class="card">${header('微信语音', '设置收到的语音如何转写，以及回复如何朗读。可选云端、自定义 API 或下方的本机服务。', primary ? voicePluginState(primary) : '', 'chat')}${pluginError}${actions}</section>
    ${localModelSettings({ header, field, toggle })}
    ${
      legacy
        ? `<details class="card technical-details" ${legacy.enabled || legacy.invalid ? 'open' : ''}>
      <summary>兼容插件 · 语音识别 API</summary>
      <p class="card-description">供已配置的语音识别及自定义请求使用。同一个聊天只能授权一个转写插件。</p>
      <div class="button-row space-top">${voicePluginState(legacy)}<button class="button" data-plugin-settings="${LEGACY_RECOGNIZER}">配置兼容插件</button>${!legacy.builtin ? `<button class="button danger" data-plugin-uninstall="${LEGACY_RECOGNIZER}">卸载</button>` : ''}</div>
    </details>`
        : ''
    }`;
}

const LOCAL_SERVICES = {
  asr: {
    title: '本机语音识别',
    description: '使用 faster-whisper 将微信语音转成文字。',
    location: '识别模型目录',
    port: 8000,
  },
  tts: {
    title: '本机语音合成',
    description: '使用 GPT-SoVITS 朗读回复。',
    location: 'GPT-SoVITS 安装目录',
    port: 9881,
  },
};
export function localModelSettings({ header, field, toggle }) {
  return Object.entries(LOCAL_SERVICES)
    .map(([kind, spec]) => {
      const key = 'runtime.localSpeech.' + kind + '.';
      return `<section class="card" data-local-model-settings>
      ${header(spec.title, spec.description, `<span class="status-tag pending" data-model-health="${kind}">读取中</span>`, 'sliders')}
      ${toggle('随应用启动', key + 'enabled', '应用打开后在后台加载模型，第一条请求可以更快处理。')}
      <div class="form-grid">${field('Python 程序', key + 'python', { browse: 'exe' })}${field(spec.location, key + 'modelDirectory', { browse: 'folder' })}</div>
      <details class="advanced"><summary>服务端口和方案文件</summary><div class="form-grid">
        ${field('服务端口', key + 'port', { type: 'number', transform: 'optional-number', min: 1024, max: 65535, placeholder: String(spec.port), help: '默认 ' + spec.port + '。保存后将重新启动服务。' })}
        ${field('方案文件', key + 'profiles', { help: '留空使用由应用管理的文件。' })}
      </div></details>
      <div class="space-top" data-model-editor="${kind}">正在读取方案…</div>
    </section>`;
    })
    .join('');
}

export function profileEditorHtml(kind, state, id, profile, candidates = {}) {
  const selected = state.selectedProfile;
  const editorFields = MODEL_FIELDS[kind]
    .map(field => {
      const { key, label, multiline, min, max, integer } = field;
      const value = profile[key] ?? field.default ?? '';
      const inputId = `voice-${kind}-${key}`;
      const control = multiline
        ? `<textarea id="${inputId}" data-model-field="${key}">${esc(value)}</textarea>`
        : `<input id="${inputId}" data-model-field="${key}" ${min !== undefined ? `type="number" min="${min}" max="${max}" step="${integer ? '1' : 'any'}"` : ''} value="${esc(value)}" ${candidates[key]?.length ? `list="local-${kind}-${key}"` : ''}>`;
      const suggestions = candidates[key]?.length
        ? `<datalist id="local-${kind}-${key}">${candidates[key].map(item => `<option value="${esc(item)}"></option>`).join('')}</datalist>`
        : '';
      return `<div class="field ${multiline ? 'full' : ''}"><label for="${inputId}">${esc(label)}</label>${control}${suggestions}</div>`;
    })
    .join('');
  const cannotDelete = id === selected || !Object.hasOwn(state.profiles, id) || Object.keys(state.profiles).length <= 1;
  return `<details class="advanced" data-model-profiles><summary>${kind === 'asr' ? '识别方案' : '音色方案'}${selected ? ' · ' + esc(state.profiles[selected]?.name || selected) : ''}</summary>
    <div class="form-grid"><div class="field"><label for="voice-${kind}-select">方案</label><select id="voice-${kind}-select" data-model-select><option value="">新增方案</option>${Object.entries(
      state.profiles,
    )
      .map(
        ([key, row]) =>
          `<option value="${esc(key)}" ${key === id ? 'selected' : ''}>${esc(row.name || key)}${key === selected ? ' · 当前使用' : ''}</option>`,
      )
      .join(
        '',
      )}</select></div><div class="field"><label for="voice-${kind}-id">方案 ID</label><input id="voice-${kind}-id" data-model-id value="${esc(id)}" ${Object.hasOwn(state.profiles, id) ? 'readonly' : ''} placeholder="${kind === 'asr' ? 'chinese' : 'dania'}"></div>${editorFields}</div>
    <div class="button-row space-top"><button type="button" class="button primary" data-model-action="use">保存并使用</button><button type="button" class="button" data-model-action="save">仅保存方案</button><button type="button" class="button" data-model-action="scan">扫描本机模型</button><button type="button" class="button" data-model-action="discard">放弃修改</button><button type="button" class="button" data-model-action="delete" ${cannotDelete ? 'disabled' : ''}>删除方案</button></div>
    <p class="card-description space-top" data-model-status role="status"></p>
    </details><p class="card-description space-top" data-model-process-status role="status"></p>`;
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
      if (!model) continue;
      const [label, tone, detail] = {
        ready: ['已就绪', 'ok', model.loadedProfile ? '当前加载 ' + model.loadedProfile + '。' : ''],
        saved: ['有待应用的方案', 'warning', '正在使用上次加载的方案。选择“保存并使用”应用更改。'],
        starting: ['正在启动', 'pending', '正在加载本机模型。'],
        loading: ['正在加载', 'pending', '正在加载所选方案。'],
        failed: ['启动失败', 'error', '请检查 Python 环境和模型路径。'],
        unavailable: ['状态未知', 'warning', '暂时无法确认模型状态。'],
        standby: ['待机', 'muted', '当前聊天使用云端服务，切换为本机服务后会加载模型。'],
        stopped: ['未启动', 'muted', '开启“随应用启动”并保存设置，可以启动本机服务。'],
      }[model.phase] ?? ['未启动', 'muted', ''];
      const badge = panel.closest?.('[data-local-model-settings]')?.querySelector('[data-model-health]');
      if (badge) {
        badge.className = 'status-tag ' + tone;
        badge.textContent = label;
      }
      if (status) status.textContent = model.error ? '无法读取方案文件，请检查路径和格式。' : detail;
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
    const replaceEditor = (id, profile, open) => {
      panel.innerHTML = profileEditorHtml(kind, saved, id, profile, candidates);
      const editor = panel.querySelector('[data-model-profiles]');
      if (editor) editor.open = open;
    };
    const paint = () => {
      const draft = drafts.get(kind);
      replaceEditor(
        draft?.id ?? selected,
        draft?.profile ?? saved.profiles[selected] ?? modelDefaults(kind),
        Boolean(draft || panel.querySelector('[data-model-profiles]')?.open),
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
          replaceEditor(id, profile, true);
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
