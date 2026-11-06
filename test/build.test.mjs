import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build, discover, nextVersion, parsePattern, parseScript, renderBundle, selectRepositories } from '../scripts/build.mjs';

const runtime = await readFile(new URL('../scripts/runtime.js', import.meta.url), 'utf8');
const config = JSON.parse(await readFile(new URL('../pure-series.config.json', import.meta.url), 'utf8'));
const template = await readFile(new URL('../README.template.md', import.meta.url), 'utf8');
const sourceText = (body = '', extra = '', match = 'https://example.com/*') => `// ==UserScript==
// @name Test
// @version 0.1.0
// @description A test script
// @match ${match}
// @run-at document-start
// @grant GM_getValue
// @grant GM_setValue
// @grant GM_addValueChangeListener
// @grant GM_registerMenuCommand
${extra}// ==/UserScript==
${body}
`;
function source(id, body, extra = '', match) {
  return { id, repository: `squarezhong/${id}`, path: 'main.user.js', commit: 'a'.repeat(40),
    ...parseScript(sourceText(body, extra, match), id) };
}
function context(url = 'https://example.com/feed', iframe = false, readyState = 'loading') {
  const listeners = {}, values = new Map(), events = [], timers = [];
  const win = {};
  win.self = win;
  win.top = iframe ? {} : win;
  const ctx = vm.createContext({
    window: win, location: { href: url }, URL, events,
    console: { error: (...args) => events.push(['error', ...args]) },
    document: { readyState, addEventListener: (event, cb) => (listeners[event] ??= []).push(cb) },
    setTimeout: callback => timers.push(callback),
    GM_getValue: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    GM_setValue: (key, value) => values.set(key, value),
    GM_addValueChangeListener: (key, callback) => { listeners[key] = callback; return 1; },
    GM_registerMenuCommand: (...args) => events.push(args),
  });
  return { ctx, values, events, listeners, timers };
}
function run(sources, env = context()) {
  const { script } = renderBundle(config, sources, runtime, '1.0.0');
  vm.runInContext(script, env.ctx);
  return env;
}
const repo = (name = 'pure-a', overrides = {}) => ({ name, owner: { login: config.owner }, private: false,
  fork: false, default_branch: 'main', ...overrides });
function fakeAPI({ text = sourceText('events.push("ok")'), truncated = false, paths = ['main.user.js'] } = {}) {
  return async route => {
    if (route.startsWith('/users/')) return [repo()];
    if (route.endsWith('/commits/main')) return { sha: 'a'.repeat(40), commit: { tree: { sha: 'tree' } } };
    if (route.endsWith('/git/trees/tree?recursive=1')) return { truncated,
      tree: paths.map(path => ({ path, type: 'blob', mode: '100644', sha: 'blob' })) };
    if (route.endsWith('/git/blobs/blob')) return { encoding: 'base64', content: Buffer.from(text).toString('base64') };
    throw new Error(`Unexpected route: ${route}`);
  };
}

test('metadata keeps CRLF, per-module frame flags and excludes', () => {
  const parsed = parseScript(sourceText('', '// @noframes\n// @exclude-match https://example.com/private/*\n').replaceAll('\n', '\r\n'), 'a');
  assert.equal(parsed.spec.noframes, true);
  assert.equal(parsed.spec.excludes.length, 1);
  assert.equal(parsed.metadata.name[0], 'Test');
});

test('unsupported execution metadata and grant none fail explicitly', () => {
  for (const key of ['require', 'resource', 'include', 'exclude', 'sandbox', 'unwrap', 'connect']) {
    assert.throws(() => parseScript(sourceText('', `// @${key} x\n`), 'a'), /unsupported @/);
  }
  assert.throws(() => parseScript(sourceText().replaceAll('GM_getValue', 'none'), 'a'), /unsupported grants/);
  assert.throws(() => parseScript(sourceText().replace('document-start', 'context-menu'), 'a'), /unsupported @run-at/);
  assert.throws(() => parseScript(sourceText('const = bad;'), 'a'), SyntaxError);
  assert.throws(() => parsePattern('file:///*'), /Unsupported match/);
  assert.throws(() => parseScript('console.log("outside");\n' + sourceText(), 'a'), /missing leading/);
});

test('repository filter excludes private, forks, self, wrong owner and explicit exclusions', () => {
  const repos = [repo(), repo('pure-series'), repo('other'), repo('pure-secret', { private: true }),
    repo('pure-fork', { fork: true }), repo('pure-wrong', { owner: { login: 'other' } }),
    repo('pure-old', { archived: true }), repo('pure-skip')];
  assert.deepEqual(selectRepositories(repos, { ...config, excludeRepositories: ['pure-skip'] }).map(x => x.name), ['pure-a', 'pure-old']);
  assert.equal(selectRepositories([repo('pure-fork', { fork: true })], { ...config, includeForks: true }).length, 1);
});

test('route only starts the matching site and respects per-module exclusions', () => {
  const sources = [source('a', 'events.push("a");', '// @exclude-match https://example.com/private/*\n'),
    source('b', 'events.push("b");', '', 'https://other.com/*')];
  assert.deepEqual(run(sources).events, ['a']);
  assert.deepEqual(run(sources, context('https://example.com/private/x')).events, []);
  assert.deepEqual(run(sources, context('https://other.com/')).events, ['b']);
  assert.deepEqual(run(sources, context('https://example.com.evil.test/')).events, []);
  assert.deepEqual(run(sources, context('http://example.com/')).events, []);
});

test('wildcard hosts include apex and subdomains, paths escape regex and ignore fragments', () => {
  const scripts = [source('a', 'events.push("ok");', '', '*://*.example.com/a.b?x=*')];
  for (const url of ['https://example.com/a.b?x=1#hash', 'http://sub.example.com/a.b?x=2']) {
    assert.deepEqual(run(scripts, context(url)).events, ['ok']);
  }
  for (const url of ['https://badexample.com/a.b?x=1', 'https://example.com/axb?x=1', 'ftp://example.com/a.b?x=1']) {
    assert.deepEqual(run(scripts, context(url)).events, []);
  }
});

test('noframes applies to each source, not the whole bundle', () => {
  const sources = [source('framed', 'events.push("framed");'), source('top', 'events.push("top");', '// @noframes\n')];
  assert.deepEqual(run(sources, context('https://example.com/', true)).events, ['framed']);
  assert.deepEqual(run(sources).events, ['framed', 'top']);
  assert.ok(!renderBundle(config, sources, runtime, '1').header.includes('@noframes'));
});

test('same storage keys are isolated, listeners receive original key and menus keep labels', () => {
  const body = 'GM_setValue("settings", VALUE); events.push(GM_getValue("settings")); GM_addValueChangeListener("settings", (...args) => events.push(args)); GM_registerMenuCommand("menu VALUE", () => {});';
  const env = run([source('a', body.replaceAll('VALUE', '1')), source('b', body.replaceAll('VALUE', '2'))]);
  assert.equal(env.values.get('a::settings'), 1);
  assert.equal(env.values.get('b::settings'), 2);
  env.listeners['a::settings']('a::settings', 1, 3, true);
  assert.deepEqual(Array.from(env.events.at(-1)), ['settings', 1, 3, true]);
  assert.equal(env.events[1][0], 'menu 1');
});

test('module scopes are separate and a synchronous exception does not stop later modules', () => {
  const env = run([source('a', 'const same = 1; throw new Error("failure");'), source('b', 'const same = 2; events.push(same);')]);
  assert.equal(env.events[0][0], 'error');
  assert.equal(env.events[1], 2);
});

test('only declared APIs are exposed as local bindings', () => {
  const item = source('a', 'events.push(typeof GM_registerMenuCommand);');
  item.metadata.grant = ['GM_getValue'];
  assert.deepEqual(run([item]).events, ['undefined']);
});

test('start, end and idle respect DOM readiness', () => {
  const sources = ['document-start', 'document-end', 'document-idle'].map(runAt => {
    const item = source(runAt, `events.push(${JSON.stringify(runAt)});`);
    item.spec.runAt = runAt;
    return item;
  });
  const env = run(sources);
  assert.deepEqual(env.events, ['document-start']);
  env.listeners.DOMContentLoaded.forEach(fn => fn());
  assert.deepEqual(env.events, ['document-start', 'document-end']);
  env.timers.forEach(fn => fn());
  assert.deepEqual(env.events, ['document-start', 'document-end', 'document-idle']);
  const loaded = run(sources, context('https://example.com/', false, 'complete'));
  assert.deepEqual(loaded.events, ['document-start', 'document-end']);
  loaded.timers.forEach(fn => fn());
  assert.equal(loaded.events.at(-1), 'document-idle');
});

test('discovery paginates, pins tree and reads blobs, excluding fixture paths', async () => {
  const api = fakeAPI({ paths: ['nested/main.user.js', 'tests/fake.user.js', 'other.user.js'] });
  const calls = [];
  const result = await discover({ ...config, excludePaths: ['pure-a/other.user.js'] }, async route => {
    calls.push(route);
    if (route.startsWith('/users/')) {
      return route.endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => repo(`other-${i}`)) : [repo()];
    }
    return api(route);
  });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].path, 'nested/main.user.js');
  assert.equal(result.sources[0].commit, 'a'.repeat(40));
  assert.ok(calls.some(route => route.endsWith('page=2')));
  assert.equal(result.sources[0].sha256.length, 64);
});

test('incomplete trees, empty discovery and fetch failures cannot produce partial bundles', async () => {
  await assert.rejects(discover(config, fakeAPI({ truncated: true })), /truncated tree/);
  await assert.rejects(discover(config, async () => []), /No eligible/);
  await assert.rejects(discover(config, async () => { throw new Error('GitHub 403'); }), /403/);
});

test('stable content keeps version; changed content increments once', () => {
  assert.equal(nextVersion(null, 'a'), '1.0.0');
  assert.equal(nextVersion({ version: '1.0.9', fingerprint: 'a' }, 'a'), '1.0.9');
  assert.equal(nextVersion({ version: '1.0.9', fingerprint: 'a' }, 'b'), '1.0.10');
});

test('full build is deterministic, never executes source, and leaves prior outputs on validation failure', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pure-series-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  await Promise.all([
    writeFile(path.join(root, 'pure-series.config.json'), JSON.stringify(config)),
    writeFile(path.join(root, 'scripts/runtime.js'), runtime),
    writeFile(path.join(root, 'README.template.md'), template),
  ]);
  const request = fakeAPI({ text: sourceText('throw new Error("must not execute at build time");') });
  const first = await build({ root, request });
  const second = await build({ root, request });
  assert.deepEqual(first.outputs, second.outputs);
  assert.ok(first.outputs['README.md'].includes('main/pure-series.user.js'));
  assert.ok(!first.outputs['README.md'].includes('{{'));
  assert.ok(first.outputs['pure-series.meta.js'].includes('@version      1.0.0'));
  await assert.rejects(build({ root, request: fakeAPI({ text: sourceText('', '// @require unsupported\n') }) }), /unsupported/);
  for (const [name, content] of Object.entries(first.outputs)) {
    assert.equal(await readFile(path.join(root, name), 'utf8'), content);
  }
  const updated = await build({ root, request: fakeAPI() });
  assert.equal(updated.version, '1.0.1');
});
