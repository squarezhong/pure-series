// Embedded verbatim by build.mjs; source code is never evaluated during a build.
function pureSeriesRun(spec, execute) {
  if (spec.noframes && window.top !== window.self) return;
  const url = new URL(location.href);
  const matches = ([scheme, host, path]) => {
    if (scheme === '*' ? !['http:', 'https:'].includes(url.protocol) : url.protocol !== `${scheme}:`) return false;
    if (host !== '*' && !(host.startsWith('*.')
      ? url.hostname === host.slice(2) || url.hostname.endsWith(`.${host.slice(2)}`)
      : url.hostname === host)) return false;
    return new RegExp(path).test(url.pathname + url.search);
  };
  if (!spec.matches.some(matches) || spec.excludes.some(matches)) return;
  const key = value => `${spec.id}::${value}`;
  const api = {
    get: typeof GM_getValue === 'function' ? (name, fallback) => GM_getValue(key(name), fallback) : undefined,
    set: typeof GM_setValue === 'function' ? (name, value) => GM_setValue(key(name), value) : undefined,
    listen: typeof GM_addValueChangeListener === 'function' ? (name, callback) =>
      GM_addValueChangeListener(key(name), (_key, oldValue, newValue, remote) => callback(name, oldValue, newValue, remote)) : undefined,
    menu: typeof GM_registerMenuCommand === 'function' ? (...args) => GM_registerMenuCommand(...args) : undefined,
  };
  const run = () => {
    try { execute(api); }
    catch (error) { console.error(`[Pure Series] ${spec.id}`, error); }
  };
  if (spec.runAt === 'document-start') run();
  else if (spec.runAt === 'document-end') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
    else run();
  } else {
    // document-idle: defer until DOMContentLoaded, then yield one task.
    const idle = () => setTimeout(run, 0);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', idle, { once: true });
    else idle();
  }
}
