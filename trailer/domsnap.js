// Snapshots of the page's interface (everything but the 3D view) as an image that can be drawn
// into a canvas without tainting it: the live DOM and the page's own CSS in an SVG
// <foreignObject>, as a data: URL (fonts inlined). Canvases in the interface (the navball, the
// map) go in as images.
const toDataUrl = (blob) => new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });

export async function makeSnapper(game) {
  let css = '';
  for (const s of document.styleSheets) {
    try {
      for (const r of s.cssRules) css += r.cssText + '\n';
    } catch {
      // (cross-origin: the web fonts, fetched below)
    }
  }
  // Web fonts, inlined (latin subsets only).
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) {
    if (!/fonts\.googleapis/.test(l.href)) continue;
    const text = await fetch(l.href).then((r) => r.text());
    const blocks = text.split('/* ').filter((b) => b.startsWith('latin */'));
    for (let b of blocks) {
      const m = b.match(/url\((https:[^)]+)\)/);
      if (m) b = b.replace(m[1], await toDataUrl(await fetch(m[1]).then((r) => r.blob())));
      css = b.slice('latin */'.length) + '\n' + css;
    }
  }
  // No <html>/<body> in the snapshot: their rules go to stand-ins.
  css = css
    .replace(/(^|[\s,>+~(}])body(?=[\s.#:[,{>+~)])/g, '$1.fb')
    .replace(/(^|[\s,>+~(}])html(?=[\s.#:[,{>+~)])/g, '$1.fh');
  const W = () => innerWidth;
  const H = () => innerHeight;
  const extra = () =>
    `*{animation:none!important;transition:none!important;caret-color:transparent}` +
    `.fh,.fb{margin:0;width:${W()}px;height:${H()}px;position:relative;overflow:hidden;background:transparent!important}`;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  // (The stylesheet and fonts, encoded once: only the markup changes between snapshots.)
  let styleKey = '';
  let styleEnc = '';
  const stats = { sync: 0, total: 0, n: 0 };

  /**
   * The interface right now, as an <img> (resolves once decoded), drawn at `scale` times its
   * CSS size (sharp at the video's resolution). hide: selectors to leave out.
   */
  async function snap(hide = [], scale = 1) {
    const t0 = performance.now();
    const key = `${W()}x${H()}`;
    if (key !== styleKey) {
      styleKey = key;
      styleEnc = encodeURIComponent(`<style>${esc(css + extra())}</style>`);
    }
    const clone = document.body.cloneNode(true);
    const orig = [...document.body.querySelectorAll('canvas')];
    const copies = [...clone.querySelectorAll('canvas')];
    orig.forEach((c, i) => {
      const cc = copies[i];
      if (c === game || c.width * c.height === 0 || c.dataset.trailer !== undefined) return cc.remove();
      const img = document.createElement('img');
      try {
        img.src = c.toDataURL();
      } catch {
        return cc.remove();
      }
      img.className = c.className;
      img.setAttribute('style', c.getAttribute('style') ?? '');
      const r = c.getBoundingClientRect();
      img.style.width = `${r.width}px`;
      img.style.height = `${r.height}px`;
      cc.replaceWith(img);
    });
    clone.querySelectorAll('script, [data-trailer]').forEach((e) => e.remove());
    for (const sel of hide) clone.querySelectorAll(sel).forEach((e) => e.remove());
    const body = document.createElement('div');
    body.className = `fb ${document.body.className}`;
    while (clone.firstChild) body.appendChild(clone.firstChild);
    const wrap = document.createElement('div');
    wrap.className = `fh ${document.documentElement.className}`;
    wrap.appendChild(body);
    const html = new XMLSerializer().serializeToString(wrap).replace(/^<div xmlns="http:\/\/www.w3.org\/1999\/xhtml"/, '<div');
    const head =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W() * scale}" height="${H() * scale}" viewBox="0 0 ${W()} ${H()}">` +
      `<foreignObject x="0" y="0" width="${W()}" height="${H()}"><div xmlns="http://www.w3.org/1999/xhtml">`;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(head) + styleEnc + encodeURIComponent(html + '</div></foreignObject></svg>');
    const t1 = performance.now();
    await img.decode();
    stats.sync += t1 - t0;
    stats.total += performance.now() - t0;
    stats.n++;
    return img;
  }
  snap.stats = stats;
  return snap;
}
