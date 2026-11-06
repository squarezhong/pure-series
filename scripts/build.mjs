import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GRANTS = ['GM_getValue', 'GM_setValue', 'GM_addValueChangeListener', 'GM_registerMenuCommand'];
const FIELDS = new Set(['name', 'namespace', 'version', 'description', 'author', 'homepage', 'homepageURL',
  'website', 'source', 'supportURL', 'updateURL', 'downloadURL', 'icon', 'iconURL', 'icon64', 'icon64URL',
  'defaulticon', 'license', 'copyright', 'match', 'exclude-match', 'run-at', 'noframes', 'grant']);
const hash = text => createHash('sha256').update(text).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const encodePath = value => value.split('/').map(encodeURIComponent).join('/');

export function parsePattern(pattern) {
  const parts = /^(https?|\*):\/\/(\*|(?:\*\.)?[a-z0-9.-]+)(\/[^\s#]*)$/i.exec(pattern);
  if (!parts) throw new Error(`Unsupported match pattern: ${pattern}`);
  const [, scheme, host, pathname] = parts;
  const escaped = pathname.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return [scheme.toLowerCase(), host.toLowerCase(), `^${escaped}$`];
}

export function parseScript(text, id) {
  const match = /^\uFEFF?\/\/ ==UserScript==\r?\n([\s\S]*?)^\/\/ ==\/UserScript==[^\S\r\n]*(?:\r?\n|$)/m.exec(text);
  if (!match || match.index !== 0) throw new Error(`${id}: missing leading userscript metadata`);
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^\/\/\s+@([\w:-]+)(?:\s+(.*))?$/.exec(line);
    if (!field) continue;
    const [, key, raw = ''] = field;
    if (!FIELDS.has(key) && !/^(name|description):[\w-]+$/.test(key)) {
      throw new Error(`${id}: unsupported @${key}; add explicit support before aggregating`);
    }
    (metadata[key] ??= []).push(raw.trim());
  }
  for (const key of ['name', 'version']) {
    if (metadata[key]?.length !== 1 || !metadata[key][0]) throw new Error(`${id}: expected one @${key}`);
  }
  if (!metadata.match?.length) throw new Error(`${id}: @match is required`);
  if (!metadata.grant?.length || metadata.grant.some(grant => !GRANTS.includes(grant))) {
    throw new Error(`${id}: unsupported grants (including @grant none / implicit sandbox)`);
  }
  if ((metadata['run-at']?.length ?? 0) > 1) throw new Error(`${id}: duplicate @run-at`);
  const runAt = metadata['run-at']?.[0] ?? 'document-idle';
  if (!['document-start', 'document-end', 'document-idle'].includes(runAt)) throw new Error(`${id}: unsupported @run-at ${runAt}`);
  const body = text.slice(match[0].length).trim();
  // Compile only: never execute downloaded code inside the build or CI process.
  new vm.Script(`(function () {\n${body}\n});`, { filename: id });
  return { metadata, body, spec: {
    id, matches: metadata.match.map(parsePattern),
    excludes: (metadata['exclude-match'] ?? []).map(parsePattern),
    noframes: Object.hasOwn(metadata, 'noframes'), runAt,
  } };
}

export function selectRepositories(repositories, config) {
  return repositories.filter(repo => !repo.private && repo.owner.login.toLowerCase() === config.owner.toLowerCase()
    && repo.name.toLowerCase().startsWith(config.prefix.toLowerCase())
    && repo.name.toLowerCase() !== config.repository.toLowerCase()
    && (config.includeForks || !repo.fork)
    && !config.excludeRepositories.includes(repo.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export async function githubRequest(route) {
  const response = await fetch(`https://api.github.com${route}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pure-series-builder',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${route}`);
  return response.json();
}

export async function discover(config, request = githubRequest) {
  const repositories = [];
  for (let page = 1; ; page++) {
    const batch = await request(`/users/${encodeURIComponent(config.owner)}/repos?type=owner&per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('Invalid repository list');
    repositories.push(...batch);
    if (batch.length < 100) break;
  }
  const sources = [];
  const skipped = [];
  for (const repo of selectRepositories(repositories, config)) {
    const base = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(repo.name)}`;
    const commit = await request(`${base}/commits/${encodeURIComponent(repo.default_branch)}`);
    const tree = await request(`${base}/git/trees/${commit.commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new Error(`${repo.name}: GitHub returned a truncated tree`);
    const files = tree.tree.filter(entry => entry.type === 'blob' && entry.mode !== '120000' && entry.path.endsWith('.user.js')
      && !entry.path.split('/').some(part => config.ignoredDirectories.includes(part))
      && !config.excludePaths.includes(`${repo.name}/${entry.path}`))
      .sort((a, b) => a.path.localeCompare(b.path, 'en'));
    if (!files.length) skipped.push(repo.name);
    for (const file of files) {
      const blob = await request(`${base}/git/blobs/${file.sha}`);
      if (blob.encoding !== 'base64') throw new Error(`${repo.name}/${file.path}: unsupported blob encoding`);
      const text = Buffer.from(blob.content, 'base64').toString('utf8');
      const id = `${repo.name}/${file.path}`;
      const parsed = parseScript(text, id);
      sources.push({ id, repository: `${config.owner}/${repo.name}`, path: file.path, commit: commit.sha,
        blob: file.sha, sha256: hash(text), ...parsed });
    }
  }
  if (!sources.length) throw new Error('No eligible userscripts found; refusing to publish an empty bundle');
  return { sources, skipped };
}

export function renderBundle(config, sources, runtime, version) {
  const home = `https://github.com/${config.owner}/${config.repository}`;
  const raw = `https://raw.githubusercontent.com/${config.owner}/${config.repository}/${encodePath(config.branch)}`;
  const lines = [
    ['name', 'Pure Series'], ['namespace', home], ['version', version],
    ['description', '一次安装，按站点自动启用 Pure 系列网页净化脚本。'], ['author', config.owner],
    ['homepageURL', home], ['supportURL', `${home}/issues`],
    ['updateURL', `${raw}/pure-series.meta.js`], ['downloadURL', `${raw}/pure-series.user.js`],
    ...[...new Set(sources.flatMap(source => source.metadata.match))].sort().map(value => ['match', value]),
    ['run-at', 'document-start'],
    ...(sources.every(source => source.spec.noframes) ? [['noframes', '']] : []),
    ...[...new Set(sources.flatMap(source => source.metadata.grant))].sort().map(value => ['grant', value]),
  ];
  const header = '// ==UserScript==\n' + lines.map(([key, value]) => `// @${key.padEnd(13)}${value}`).join('\n') + '\n// ==/UserScript==\n';
  const modules = sources.map(source => {
    // Only declared APIs are passed into each module; storage keys are namespaced by stable source ID.
    const apiNames = ['get', 'set', 'listen', 'menu'];
    const args = GRANTS.map((grant, index) => source.metadata.grant.includes(grant) ? `api.${apiNames[index]}` : 'undefined');
    return `// Source: https://github.com/${source.repository}/blob/${source.commit}/${encodePath(source.path)}\n`
      + `// Original metadata: ${JSON.stringify(source.metadata)}\n`
      + `pureSeriesRun(${JSON.stringify(source.spec)}, function (api) {\n`
      + `(function (${GRANTS.join(', ')}) {\n${source.body}\n}).call(this, ${args.join(', ')});\n});`;
  });
  return { header, script: `${header}\n// Generated by scripts/build.mjs. Do not edit.\n(function () {\n${runtime.trim()}\n\n${modules.join('\n\n')}\n})();\n` };
}

export function nextVersion(previous, fingerprint) {
  if (previous?.fingerprint === fingerprint) return previous.version;
  if (!previous) return '1.0.0';
  if (!/^1\.0\.\d+$/.test(previous.version)) throw new Error('Invalid build-state version');
  return `1.0.${Number(previous.version.split('.')[2]) + 1}`;
}

const md = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('|', '&#124;').replace(/[\r\n]/g, ' ').replaceAll('[', '&#91;').replaceAll(']', '&#93;');

export function renderReadme(config, sources, skipped, version, template) {
  const raw = `https://raw.githubusercontent.com/${config.owner}/${config.repository}/${encodePath(config.branch)}`;
  const table = ['| 脚本 | 版本 | 来源 |', '| --- | --- | --- |', ...sources.map(source => {
    const url = `https://github.com/${source.repository}/blob/${source.commit}/${encodePath(source.path)}`;
    return `| ${md(source.metadata.name[0])} | ${md(source.metadata.version[0])} | [${md(source.repository)}](${url}) |`;
  })].join('\n');
  return template.replaceAll('{{INSTALL_URL}}', `${raw}/pure-series.user.js`)
    .replaceAll('{{VERSION}}', version).replaceAll('{{COUNT}}', String(sources.length))
    .replaceAll('{{OWNER}}', config.owner).replaceAll('{{REPOSITORY}}', config.repository)
    .replaceAll('{{BRANCH}}', config.branch).replaceAll('{{TABLE}}', table)
    .replaceAll('{{SKIPPED}}', skipped.length ? skipped.map(md).join('、') : '无');
}

export async function build({ root = ROOT, request = githubRequest } = {}) {
  const [configText, runtime, template, previousText] = await Promise.all([
    readFile(path.join(root, 'pure-series.config.json'), 'utf8'),
    readFile(path.join(root, 'scripts/runtime.js'), 'utf8'),
    readFile(path.join(root, 'README.template.md'), 'utf8'),
    readFile(path.join(root, 'build-state.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return 'null';
      throw error;
    }),
  ]);
  const config = JSON.parse(configText);
  const { sources, skipped } = await discover(config, request);
  const fingerprint = hash(renderBundle(config, sources, runtime, 'VERSION').script);
  const version = nextVersion(JSON.parse(previousText), fingerprint);
  const { header, script } = renderBundle(config, sources, runtime, version);
  new vm.Script(script, { filename: 'pure-series.user.js' });
  const manifest = { version, sources: sources.map(({ body, ...source }) => source), skipped };
  const outputs = {
    'pure-series.user.js': script, 'pure-series.meta.js': header,
    'sources.json': json(manifest), 'build-state.json': json({ version, fingerprint }),
    'README.md': renderReadme(config, sources, skipped, version, template),
  };
  // No output is changed until every source, metadata block and complete bundle passes validation.
  for (const [name, content] of Object.entries(outputs)) await writeFile(path.join(root, name), content);
  console.log(`Built Pure Series ${version}: ${sources.length} scripts; skipped ${skipped.length} repositories without eligible scripts.`);
  return { version, sources, outputs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build().catch(error => { console.error(error.message); process.exitCode = 1; });
}
