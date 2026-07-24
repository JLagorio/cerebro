// templates/cerebro-app/ds-base.js — loads the Cerebro design system for this template.
// In a consuming project, point `base` at the bound _ds/<folder> tree relative to this page.
(() => {
  const base = '_ds/cerebro-design-system-d5fb9b6c-a7d7-40f8-ad80-3a48e4462af5';
  for (const p of ['styles.css']) {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = base + '/' + p;
    document.head.appendChild(l);
  }
  const load = (src, next) => {
    const s = document.createElement('script');
    s.src = src; s.async = false;
    if (next) s.onload = next;
    s.onerror = () => console.error('ds-base.js: failed to load ' + src + ' — if this is a consuming project, point the base line in ds-base.js at the bound _ds/<folder> tree relative to this page; in a fresh design system this can just mean the bundle is not compiled yet');
    document.head.appendChild(s);
  };
  load('https://unpkg.com/react@18.3.1/umd/react.development.js',
    () => load('https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js',
      () => load(base + '/_ds_bundle.js')));
})();
