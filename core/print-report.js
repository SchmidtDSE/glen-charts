/**
 * A print report: the profile on the screen laid out as a document to save as
 * PDF, for readers rather than re-runners (the HTML export carries the code).
 * A cover with the title, map and headline numbers, then one section per
 * theme, then notes, data citations and the link back to the live view.
 *
 * The report reuses the rendered panels (tiles, SVG charts, extension charts
 * such as tables) and the page's own stylesheets, so whatever the app shows,
 * the report shows. It opens in a new tab, where the browser's print dialog
 * saves it ("Save as PDF"); running headers and page numbers use CSS page
 * margin boxes.
 *
 * app.json "report" (all optional):
 *   title     cover title template: {area}, {kind}, {settings}, {app}
 *             (default "{area}"); an extension's reportTitle(aoi, ctx) wins
 *   subtitle  template as title (default "{kind} · {settings}")
 *   org       who publishes the report, on the cover and in the citation
 *   logo      image URL for the cover, or [{ src, alt }] for several
 *   accent    cover and heading colour (default the app's --primary)
 *   page      "letter" (default) or "A4"
 *   citation  "how to cite" template: {title}, {org}, {app}, {date}, {year}, {url}
 *   note      HTML shown under "About this report"
 */

import { escapeHtml } from './format.js';
import { matchSources } from './sources.js';
import { GEO_AGENT_EXPORT, settled, mapSnapshot, usedQueries, sourcesHtml } from './export.js';

const fill = (tpl, vals) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vals[k] ?? ''));
const cssString = s => `"${String(s).replace(/["\\]/g, '\\$&').replace(/\s+/g, ' ')}"`;

/**
 * Build the report document's HTML.
 *
 * @param {object} o   as exportReport's options (engine, aoi, kind, subtitle (the
 *                     settings), themes, mapView, reportEl, legendEl, siteTitle, base,
 *                     projectUrl, reference), plus report (app.json "report") and
 *                     title (an extension's title for this view, if any)
 */
export async function buildPrintReport(o) {
    await settled(o.reportEl);
    const cfg = o.report || {};
    const date = new Date();
    const dateText = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const vals = { area: o.aoi.label, kind: o.kind || '', settings: o.subtitle || '', app: o.siteTitle || '' };
    const title = o.title || fill(cfg.title || '{area}', vals);
    const subtitle = fill(cfg.subtitle || '{kind} · {settings}', vals).replace(/^\s*·\s*|\s*·\s*$/g, '');
    const url = location.href;

    const snapshot = await coverMap(o.mapView.map);
    const datasets = await citations(o).catch(() => []);

    // the overview (first theme) gives the cover's numbers and opens the report
    const cards = o.themes.map(t => ({ theme: t, card: o.reportEl.querySelector(`.card[data-theme="${CSS.escape(t.id)}"]`) }))
        .filter(x => x.card);
    const [first, ...rest] = cards;
    const coverTiles = first?.card.querySelector('.tiles');
    // what the app puts between the report title and the panels (e.g. a "How to read this" note)
    const notes = [...o.reportEl.children]
        .filter(el => !el.matches('.report-head, .card[data-theme], script, style'))
        .map(el => clean(el).outerHTML).join('\n');

    const logos = (Array.isArray(cfg.logo) ? cfg.logo : cfg.logo ? [{ src: cfg.logo, alt: cfg.org || '' }] : [])
        .map(l => (typeof l === 'string' ? { src: l, alt: '' } : l))
        .map(l => `<img class="pr-logo" src="${escapeHtml(new URL(l.src, location.href).href)}" alt="${escapeHtml(l.alt || '')}">`).join('');
    let legend = '';
    if (o.legendEl && !o.legendEl.hidden) {
        const lg = clean(o.legendEl);
        lg.querySelectorAll('input, label').forEach(n => n.remove());
        legend = `<div class="pr-legend">${lg.innerHTML}</div>`;
    }
    const cite = fill(cfg.citation || '{org}{app}. ({year}). {title}. Report generated {date}. {url}', {
        title, org: cfg.org ? `${cfg.org}. ` : '', app: o.siteTitle || '', date: dateText, year: date.getFullYear(), url,
    }).replace(/^\.\s*/, '');

    const section = ({ theme, card }, i) => {
        const c = clean(card);
        const tiles = i === 0 ? '' : c.querySelector('.tiles')?.outerHTML || '';
        const charts = c.querySelector('.charts')?.outerHTML || '';
        return `<section class="pr-section${i === 0 ? ' pr-first' : ''}" style="--c:${escapeHtml(theme.color || 'var(--pr-accent)')}">
  <h2>${escapeHtml(i === 0 ? (theme.label || 'At a glance') : theme.label)}</h2>
  ${theme.blurb && i ? `<p class="pr-blurb">${escapeHtml(theme.blurb)}</p>` : ''}
  ${i === 0 && notes ? `<div class="pr-notes">${notes}</div>` : ''}
  ${tiles}${charts}
</section>`;
    };
    const methods = cards.filter(x => x.theme.method)
        .map(x => `<p><b>${escapeHtml(x.theme.label || 'Overview')}.</b> ${escapeHtml(x.theme.method)}</p>`).join('\n');

    const sheets = [...document.querySelectorAll('link[rel="stylesheet"], style')].map(n =>
        n.tagName === 'LINK' ? `<link rel="stylesheet" href="${escapeHtml(n.href)}">` : `<style>${n.textContent}</style>`).join('\n');
    const head = `${title}${subtitle ? ` · ${subtitle}` : ''}`;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(o.siteTitle || 'Report')}</title>
${sheets}
<style>${PRINT_CSS}
@page { size: ${cfg.page === 'A4' ? 'A4' : 'letter'}; margin: 0.65in 0.6in 0.7in;
  @top-left { content: ${cssString(head)}; font: 8.5pt Inter, system-ui, sans-serif; color: #77706b; }
  @bottom-left { content: ${cssString(o.siteTitle || '')}; font: 8.5pt Inter, system-ui, sans-serif; color: #77706b; }
  @bottom-right { content: counter(page) " / " counter(pages); font: 8.5pt Inter, system-ui, sans-serif; color: #77706b; } }
@page :first { margin: 0.5in; @top-left { content: none; } @bottom-left { content: none; } @bottom-right { content: none; } }
${cfg.accent ? `:root { --pr-accent: ${cfg.accent}; }` : ''}
</style>
</head>
<body class="pr-body">
<div class="pr-toolbar">
  <span>Choose <b>Save as PDF</b> as the printer to keep this report as a PDF.</span>
  <button type="button" onclick="window.print()">Print / save as PDF</button>
</div>
<main class="pr-doc">
<section class="pr-cover">
  <div class="pr-cover-top">${logos}<p class="pr-kicker">${escapeHtml(o.siteTitle || '')}</p></div>
  <h1>${escapeHtml(title)}</h1>
  ${subtitle ? `<p class="pr-subtitle">${escapeHtml(subtitle)}</p>` : ''}
  ${snapshot ? `<figure class="pr-map"><img src="${snapshot}" alt="Map of ${escapeHtml(o.aoi.label)}">${legend}</figure>` : ''}
  ${coverTiles ? `<div class="pr-cover-tiles">${clean(coverTiles).outerHTML}</div>` : ''}
  <p class="pr-cover-foot">${escapeHtml(cfg.org ? `${cfg.org} · ` : '')}${escapeHtml(dateText)}</p>
</section>
${cards.map(section).join('\n')}
<section class="pr-about">
  <h2>About this report</h2>
  ${cfg.note ? `<div class="pr-about-note">${cfg.note}</div>` : ''}
  <p>No AI model produced these numbers. Each comes from fixed SQL over public datasets, the same queries the
     <a href="${escapeHtml(url)}">live view</a> runs; the app's <b>Export</b> gives that code with every result.</p>
  ${o.reference?.citation ? `<p>${escapeHtml(o.reference.note || 'Definitions follow')} ${o.reference.url ? `<a href="${escapeHtml(o.reference.url)}">${escapeHtml(o.reference.citation)}</a>` : escapeHtml(o.reference.citation)}</p>` : ''}
  ${methods ? `<h3>Methods</h3>${methods}` : ''}
  <h3>How to cite this report</h3>
  <p class="pr-cite">${escapeHtml(cite)}</p>
  <h3>Live view</h3>
  <p class="pr-url"><a href="${escapeHtml(url)}">${escapeHtml(url)}</a>${o.projectUrl ? `<br>Source code: <a href="${escapeHtml(o.projectUrl)}">${escapeHtml(o.projectUrl)}</a>` : ''}</p>
  ${sourcesHtml(datasets)}
</section>
</main>
<script>${FIT_SCRIPT.replace('__PAGE__', cfg.page === 'A4' ? '11.69' : '11')}</script>
</body>
</html>`;
}

/**
 * The map for the cover: drawn at a fixed landscape size, showing what the
 * reader was looking at, then the live map is put back as it was.
 */
async function coverMap(map, width = 1400, height = 1150) {
    const box = map.getContainer();
    const bounds = map.getBounds();
    const camera = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
    const saved = box.getAttribute('style') || '';
    try {
        Object.assign(box.style, { width: `${width}px`, height: `${height}px`, position: 'fixed', left: '0', top: '0', zIndex: '-1' });
        map.resize();
        map.fitBounds(bounds, { padding: 20, animate: false });
        await new Promise(resolve => { map.once('idle', resolve); setTimeout(resolve, 8000); });
        return await mapSnapshot(map);
    } catch {
        return null;
    } finally {
        box.setAttribute('style', saved);
        map.resize();
        map.jumpTo(camera);
    }
}

/** A copy of a rendered element without its live controls, every fold open. */
function clean(el) {
    const k = el.cloneNode(true);
    k.querySelectorAll('details.method, button, input, select, .map-btn, .skeleton').forEach(n => n.remove());
    [k, ...k.querySelectorAll('details')].filter(d => d.tagName === 'DETAILS').forEach(d => d.setAttribute('open', ''));
    return k;
}

/** The datasets the shown queries read or the map draws, with catalog citations. */
async function citations(o) {
    const r = await fetch(`${o.base || '.'}/data/sources.json`, { cache: 'no-cache' });
    if (!r.ok) return [];
    const sources = await r.json();
    const sqls = [];
    for (const t of o.themes) {
        for (const name of usedQueries(t, o.engine.config.app, o.aoi.params)) {
            try { sqls.push(o.engine.sqlFor(t, name, o.aoi)); } catch { /* not runnable here */ }
        }
    }
    const style = o.mapView.map.getStyle();
    const tileUrls = Object.values(style.sources || {}).map(s => String(s.url || '').replace(/^pmtiles:\/\//, '')).filter(Boolean);
    const ga = await import(GEO_AGENT_EXPORT);
    return matchSources(sources, sqls, tileUrls).map(d => ({ ...ga.datasetCitation(d.stac), queried: d.queried, mapped: d.mapped }));
}

/**
 * Hook a "Report" button. The tab opens at the click (a tab opened after the
 * report is built would be blocked as a pop-up) and fills when it is ready.
 */
export function wirePrintButton(btn, getOptions) {
    btn.onclick = async () => {
        if (btn.disabled) return;
        const w = window.open('', '_blank');
        if (!w) { btn.title = 'Allow pop-ups for this site to open the report'; return; }
        w.document.write('<!doctype html><title>Preparing report…</title><p style="font:15px system-ui;margin:2rem">Preparing the report… Panels still loading are waited for.</p>');
        const label = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Preparing…';
        try {
            const html = await buildPrintReport(getOptions());
            w.document.open();
            w.document.write(html);
            w.document.close();
            btn.textContent = label;
        } catch (err) {
            console.error(err);
            w.document.body.innerHTML = `<p style="font:15px system-ui;margin:2rem">The report failed: ${escapeHtml(err.message || String(err))}</p>`;
            btn.textContent = 'Report failed';
            setTimeout(() => { btn.textContent = label; }, 2500);
        }
        btn.disabled = false;
    };
}

/**
 * Fit the report to pages. A chart is an image and cannot split by itself, so
 * one that misses the rest of a page would move whole to the next and leave a
 * gap. This walks the report as the printer will (the screen column has the
 * printed width) and, for a chart or a row of charts that does not fit:
 * narrows its drawing to the space left when that keeps it at 70% of its size
 * or more (titles and legends keep their size); else, with a fifth of a page
 * or more left, cuts the drawing between two rows of bars and continues it on
 * the next page; else moves it to the next page. A section starts a new page
 * only when less than a third of a page is left. Tables split by row.
 */
const FIT_SCRIPT = `
(function () {
  function px(inches) { var d = document.createElement('div'); d.style.height = inches + 'in'; document.body.appendChild(d); var h = d.getBoundingClientRect().height; d.remove(); return h; }
  function box(els) {
    var t = Infinity, b = -Infinity;
    els.forEach(function (e) { var r = e.getBoundingClientRect(); t = Math.min(t, r.top); b = Math.max(b, r.bottom); });
    return { top: t, bottom: b, h: b - t };
  }
  function svgs(els) { var a = []; els.forEach(function (e) { e.querySelectorAll('svg').forEach(function (g) { a.push(g); }); }); return a; }
  // the drawn part of a row of charts, which scales with its width
  function drawnHeight(els) {
    var h = 0;
    els.forEach(function (e) { var s = 0; e.querySelectorAll('svg').forEach(function (g) { s += g.getBoundingClientRect().height; }); h = Math.max(h, s); });
    return h;
  }
  function shrink(els, s) { svgs(els).forEach(function (g) { g.style.width = (s * 100).toFixed(1) + '%'; }); }
  // cut a one-drawing chart between two rows of text so its top part fits in
  // maxPx of the page; the rest goes into a new chart box after it
  function split(el, maxPx) {
    var g = el.querySelectorAll('svg');
    if (g.length !== 1 || !g[0].viewBox || !g[0].viewBox.baseVal || !g[0].viewBox.baseVal.height) return null;
    g = g[0];
    var vb = g.viewBox.baseVal, gr = g.getBoundingClientRect(), k = gr.height / vb.height;
    var above = gr.top - el.getBoundingClientRect().top;
    var ys = [], x0 = vb.x, x1 = vb.x + vb.width;
    g.querySelectorAll('text').forEach(function (t) {
      try { var b = t.getBBox(); ys.push(b.y + b.height / 2); x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x + b.width); } catch (e) {}
    });
    ys.sort(function (a, b) { return a - b; });
    var rows = ys.filter(function (y, i) { return i === 0 || y - ys[i - 1] > 3; });
    var cut = null;
    for (var i = 1; i < rows.length; i++) {
      var c = (rows[i - 1] + rows[i]) / 2;
      if (above + (c - vb.y) * k <= maxPx && c - vb.y > 0.2 * vb.height && vb.y + vb.height - c > 0.1 * vb.height) cut = c;
    }
    if (cut === null) return null;
    var rest = el.cloneNode(false);
    rest.classList.add('pr-cont');
    var g2 = g.cloneNode(true);
    // labels may run past the frame; widen it to keep them whole
    g2.setAttribute('viewBox', [x0, cut, x1 - x0, vb.y + vb.height - cut].join(' '));
    g2.removeAttribute('height');
    rest.appendChild(g2);
    // charts draw with overflow visible: the two parts must clip at the cut
    g.style.overflow = g2.style.overflow = 'hidden';
    g.setAttribute('viewBox', [x0, vb.y, x1 - x0, cut - vb.y].join(' '));
    g.removeAttribute('height');
    // in a grid of charts, under the first part rather than beside it
    rest.style.gridColumnStart = '1';
    el.after(rest);
    return rest;
  }
  function fit() {
    var pageH = px(__PAGE__ - 0.65 - 0.7) - 20;
    var cursor = 0, prevBottom = null;
    document.querySelectorAll('.pr-section').forEach(function (sec, si) {
      if (si > 0 && pageH - cursor < pageH / 3) { sec.classList.add('pr-new-page'); cursor = 0; prevBottom = null; }
      else if (si === 0) { cursor = 0; prevBottom = null; }
      // blocks in reading order; charts sharing a top edge form one row
      var queue = [];
      Array.prototype.forEach.call(sec.children, function (el) {
        if (!el.classList.contains('charts')) { queue.push({ els: [el], split: el.matches('.pr-notes') }); return; }
        var rows = [];
        Array.prototype.forEach.call(el.children, function (c) {
          var top = Math.round(c.getBoundingClientRect().top);
          var row = rows.filter(function (r) { return Math.abs(r.top - top) < 3; })[0];
          if (row) row.els.push(c); else rows.push({ top: top, els: [c] });
        });
        rows.forEach(function (r) { queue.push({ els: r.els, split: r.els.some(function (c) { return c.querySelector('table'); }) }); });
      });
      for (var q = 0; q < queue.length; q++) {
        var b = queue[q], r = box(b.els);
        if (prevBottom !== null) cursor += Math.max(0, r.top - prevBottom);
        if (b.split) {
          cursor += r.h;
          while (cursor > pageH) cursor -= pageH;
        } else if (cursor + r.h <= pageH) {
          cursor += r.h;
        } else {
          var free = pageH - cursor, d = drawnHeight(b.els), s = d ? (d - (r.h - free)) / d : 0, rest = null;
          if (free > 0.15 * pageH && s >= 0.7) {
            shrink(b.els, s);
          } else if (free > 0.2 * pageH && b.els.length === 1 && (rest = split(b.els[0], free))) {
            queue.splice(q + 1, 0, { els: [rest], split: false });
          } else {
            // the next page; a drawing taller than a page is cut again there
            cursor = 0;
            if (r.h > pageH && b.els.length === 1 && (rest = split(b.els[0], pageH))) queue.splice(q + 1, 0, { els: [rest], split: false });
          }
          r = box(b.els);
          cursor += r.h;
        }
        prevBottom = r.bottom;
      }
    });
  }
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(function () { setTimeout(fit, 50); });
})();
`;

const PRINT_CSS = `
:root { --pr-accent: var(--primary, #006837); }
html, body.pr-body { height: auto; background: #e9e7e3; }
body.pr-body { margin: 0; color: var(--text, #22201f); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pr-toolbar { position: sticky; top: 0; z-index: 2; display: flex; gap: 16px; align-items: center; justify-content: center;
  padding: 10px 16px; background: #fff; border-bottom: 1px solid #d9d5cf; font-size: 13px; color: #4f4a47; }
.pr-toolbar button { font: inherit; font-weight: 600; padding: 6px 14px; border-radius: 6px; border: 0; cursor: pointer;
  background: var(--pr-accent); color: #fff; }
.pr-doc { max-width: 8.5in; margin: 24px auto 48px; background: #fff; padding: 0.6in; box-shadow: 0 1px 6px rgba(0,0,0,.12); }
.pr-doc a { color: inherit; }

.pr-cover { display: flex; flex-direction: column; min-height: 9.6in; }
.pr-cover-top { display: flex; align-items: center; gap: 14px; border-bottom: 3px solid var(--pr-accent); padding-bottom: 10px; }
.pr-logo { max-height: 44px; max-width: 2.2in; }
.pr-kicker { margin: 0; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--pr-accent); font-weight: 650; }
.pr-cover h1 { font-size: 34px; line-height: 1.1; margin: 22px 0 6px; letter-spacing: -.01em; }
.pr-subtitle { margin: 0 0 16px; font-size: 15px; color: var(--text-2, #4f4a47); }
.pr-map { position: relative; margin: 0 0 16px; overflow: hidden; border-radius: 6px; border: 1px solid #ddd8d0; }
.pr-map img { display: block; width: 100%; height: auto; }
.pr-legend { position: absolute; left: 10px; bottom: 10px; background: rgba(255,255,255,.92); border-radius: 6px;
  padding: 7px 9px; font-size: 10.5px; max-width: 2.8in; }
.pr-legend [hidden] { display: none; }
.pr-legend .ov + .ov { margin-top: 6px; }
.pr-cover-tiles .tiles { display: grid; grid-template-columns: repeat(var(--n, 4), minmax(0, 1fr)); gap: 8px; }
.pr-cover-tiles .tiles[data-n="2"] { --n: 2; } .pr-cover-tiles .tiles[data-n="3"] { --n: 3; }
.pr-cover-tiles .tile-value { font-size: 26px; }
.pr-cover-foot { margin: 14px 0 0; font-size: 11.5px; color: var(--text-3, #77706b); }

.pr-section { container-type: inline-size; margin-top: 30px; }
.pr-section.pr-first, .pr-section.pr-new-page { break-before: page; margin-top: 0; }
.pr-section h2 { break-after: avoid; }
.pr-section .chart.pr-cont { margin-top: 0; }
.pr-section h2 { font-size: 22px; margin: 0 0 6px; padding-bottom: 6px; border-bottom: 3px solid var(--c); }
.pr-blurb { color: var(--text-2, #4f4a47); font-size: 13px; margin: 0 0 12px; }
.pr-notes { font-size: 12.5px; margin: 10px 0 14px; }
.pr-notes .card { border: 1px solid #e3dfd8; box-shadow: none; padding: 10px 12px; margin: 0; }
.pr-notes summary { list-style: none; } .pr-notes summary::-webkit-details-marker { display: none; }
.pr-section .tiles { margin: 10px 0 4px; }
.pr-section .chart { break-inside: avoid; margin-top: 16px; }
.pr-section .chart:has(table) { break-inside: auto; }
.pr-section tr { break-inside: avoid; }
.pr-section thead { display: table-header-group; }
.pr-section .chart h4 { font-size: 13.5px; }

.pr-about { break-before: page; font-size: 12.5px; }
.pr-about h2 { font-size: 22px; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 3px solid var(--pr-accent); }
.pr-about h3 { font-size: 14px; margin: 18px 0 4px; }
.pr-cite { padding: 8px 10px; background: var(--surface, #f5faf1); border-radius: 6px; }
.pr-url { word-break: break-all; }
.report-sources { margin: 22px 0 0; padding-top: 10px; border-top: 1px solid #ddd8d0; }
.report-sources h2 { font-size: 15px; border: 0; padding: 0; margin: 0 0 4px; }
.report-appendix-note, .ds-meta { color: var(--text-3, #77706b); font-size: 11px; }
.ds-list { padding-left: 1.2rem; } .ds-list li { margin: 0 0 8px; break-inside: avoid; } .ds-list p { margin: 1px 0; }

@media print {
  html, body.pr-body { background: #fff; }
  .pr-toolbar { display: none; }
  .pr-doc { max-width: none; margin: 0; padding: 0; box-shadow: none; }
  .pr-cover { min-height: 9.9in; }
  .pr-doc a { text-decoration: none; }
}
`;
