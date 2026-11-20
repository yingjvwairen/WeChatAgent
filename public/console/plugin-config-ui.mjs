// Every open rebuilds from the currently installed package's descriptor/schema.
export function pluginSettingsMarkup(item, rows, esc) {
  const ui = item.configUi;
  const grid = entries => `<div class="form-grid">${entries.map(row => row.html).join('')}</div>`;
  if (!ui) return `${item.configUiError ? `<p class="inline-error">${esc(item.configUiError)}</p>` : ''}${grid(rows)}`;
  const used = new Set();
  const sections = ui.sections.map(section => {
    const fields = section.fields.map(key => { used.add(key); return rows.find(row => row.key === key); }).filter(Boolean);
    const content = grid(fields);
    return section.advanced
      ? `<details class="plugin-config-advanced"><summary>${esc(section.title)}</summary>${content}</details>`
      : `<section class="plugin-config-section"><h3>${esc(section.title)}</h3>${content}</section>`;
  }).join('');
  const other = rows.filter(row => !used.has(row.key));
  return `${ui.description ? `<p class="modal-description">${esc(ui.description)}</p>` : ''}${sections}${other.length ? grid(other) : ''}`;
}
