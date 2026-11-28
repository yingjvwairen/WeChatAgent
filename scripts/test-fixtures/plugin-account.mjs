import path from 'node:path';
import { atomicJson } from '../../packages/plugin-api/catalog.mjs';

export const fixturePluginAccount = 'a'.repeat(64);

export function selectPluginAccount(root, id = fixturePluginAccount) {
  atomicJson(path.join(root, 'state/weflow/active-account.json'), { id });
}
