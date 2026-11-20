import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Plugin fixtures are copied into isolated temporary trees. Keep the plugin's
// real authorization implementation while resolving its source-only imports.
export function copyUiSelectionFixture(pluginDirectory) {
  const root = path.resolve(import.meta.dirname, '..');
  let source = fs.readFileSync(path.join(root, 'packages/dsh-social-bridge-plugin/ui-selection-policy.mjs'), 'utf8');
  for (const name of ['scripts/reader-account-state.mjs', 'scripts/target-selection.mjs', 'components/qq-bridge/src/core/selection-scope.js']) {
    source = source.replace(JSON.stringify('../../' + name), JSON.stringify(pathToFileURL(path.join(root, name)).href))
      .replace("'../../" + name + "'", JSON.stringify(pathToFileURL(path.join(root, name)).href));
  }
  fs.writeFileSync(path.join(pluginDirectory, 'ui-selection-policy.mjs'), source);
}
