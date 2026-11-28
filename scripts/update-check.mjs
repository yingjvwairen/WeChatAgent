import fs from 'node:fs';
import path from 'node:path';
export const UPDATE_REPOSITORY = 'sourcepro5/WeChatAgent';
const releaseRoot = 'https://github.com/' + UPDATE_REPOSITORY + '/releases/';
const version = value => {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(-fix|\+)?$/.exec(String(value ?? ''));
  return match
    ? {
        parts: match.slice(1, 4).map(Number),
        revision: match[4] === '+' ? 2 : match[4] === '-fix' ? 1 : 0,
        label: match.slice(1, 4).join('.') + (match[4] ?? ''),
      }
    : null;
};
// Public labels are ordered: base < -fix < +, before the next numeric release.
export function compareVersions(a, b) {
  const left = version(a),
    right = version(b);
  if (!left || !right) throw Error('INVALID_VERSION');
  for (let i = 0; i < 3; i++) if (left.parts[i] !== right.parts[i]) return left.parts[i] > right.parts[i] ? 1 : -1;
  return left.revision - right.revision;
}
function metadata(root) {
  const installedRecord = 'config/distribution.json';
  for (const file of ['deployment.json', installedRecord, 'package.json']) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
      if (file === installedRecord && data.installed !== true) continue;
      const publicVersion = version(data.releaseVersion ?? data.version);
      if (publicVersion) return { version: publicVersion.label, buildId: data.buildId, builtAt: data.builtAt };
    } catch {
      // Check the remaining metadata sources in source and installed workspaces.
    }
  }
  return { version: '0.3.6' };
}
function sameDownloadUrl(actual, expected) {
  try {
    const a = new URL(actual),
      b = new URL(expected);
    return (
      a.origin === b.origin &&
      !a.username &&
      !a.password &&
      !a.search &&
      !a.hash &&
      decodeURIComponent(a.pathname) === decodeURIComponent(b.pathname)
    );
  } catch {
    return false;
  }
}
async function jsonResponse(response) {
  let size = 0,
    text = '';
  if (!response.body) return response.json();
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 128 * 1024) {
      await response.body.cancel?.().catch(() => {});
      throw Error('UPDATE_RESPONSE_TOO_LARGE');
    }
    text += Buffer.from(chunk).toString('utf8');
  }
  return JSON.parse(text);
}
export function createUpdateChecker({ root, fetchImpl = fetch, now = Date.now } = {}) {
  const local = metadata(root);
  let cached,
    inflight,
    checkedAt = 0;
  const base = { currentVersion: local.version, repository: UPDATE_REPOSITORY, releaseUrl: releaseRoot + 'latest' };
  async function request(url, signal) {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'WeChatAgent-UpdateCheck/' + local.version },
      signal,
    });
    return { response, data: response.ok ? await jsonResponse(response) : null };
  }
  async function run() {
    const signal = AbortSignal.timeout(8000),
      stamp = new Date(now()).toISOString();
    try {
      const { response, data } = await request(
        'https://api.github.com/repos/' + UPDATE_REPOSITORY + '/releases/latest',
        signal,
      );
      if (response.status === 404) return { ...base, status: 'not_published', checkedAt: stamp };
      if (!response.ok) throw Error('UPDATE_HTTP_' + response.status);
      if (data.draft || data.prerelease || !version(data.tag_name)) throw Error('UPDATE_RELEASE_INVALID');
      const latestVersion = version(data.tag_name).label,
        tag = encodeURIComponent(data.tag_name);
      function assetUrl(name) {
        const expected = releaseRoot + 'download/' + tag + '/' + encodeURIComponent(name);
        const uploaded = (data.assets ?? []).some(
          asset =>
            asset.name === name && asset.state === 'uploaded' && sameDownloadUrl(asset.browser_download_url, expected),
        );
        return uploaded ? expected : undefined;
      }
      const downloadUrl = assetUrl('WeChatAgent-Setup-' + latestVersion + '-x64.exe');
      const comparison = compareVersions(latestVersion, local.version);
      if (!downloadUrl || comparison < 0) return { ...base, status: 'up_to_date', checkedAt: stamp };
      let sameVersionBuild = false;
      const buildIdPattern = /^[a-f0-9]{16}$/;
      const localBuildTime = Date.parse(local.builtAt);
      if (comparison === 0 && buildIdPattern.test(local.buildId) && Number.isFinite(localBuildTime)) {
        const infoUrl = assetUrl('VERIFICATION-' + latestVersion + '.json') ?? assetUrl('VERIFICATION.json');
        if (infoUrl) {
          const { data: remote } = await request(infoUrl, signal);
          sameVersionBuild =
            remote?.version === local.version &&
            buildIdPattern.test(remote.buildId) &&
            remote.buildId !== local.buildId &&
            Date.parse(remote.builtAt) > localBuildTime;
        }
      }
      const available = comparison > 0 || sameVersionBuild;
      return {
        ...base,
        status: available ? 'available' : 'up_to_date',
        latestVersion,
        sameVersionBuild,
        checkedAt: stamp,
        releaseUrl: releaseRoot + 'tag/' + tag,
        ...(available ? { downloadUrl } : {}),
      };
    } catch {
      return { ...base, status: 'unavailable', checkedAt: stamp };
    }
  }
  return {
    check({ force = false } = {}) {
      const at = now();
      if (inflight) return inflight;
      if (cached && at - checkedAt < (force ? 15000 : 6 * 60 * 60 * 1000)) return Promise.resolve(cached);
      inflight = run()
        .then(result => {
          cached = result;
          checkedAt = now();
          return result;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}
