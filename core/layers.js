/**
 * createLayers: a page documenting every layer (variable) of an app's themes,
 * one section per layer, for compare-mode apps whose metrics link here
 * (app.json compare.layers_page).
 *
 *   import { createLayers } from '.../glen-charts@vX/core/layers.js';
 *   createLayers({ explorer: './' });
 *
 * Each section prints the layer's facts from theme.json (source, resolution,
 * unit, direction, licence) and then its documentation, the Markdown file
 * <theme dir>/layers/<variable id>.md, rendered with `marked` when the page
 * loads it (otherwise shown as plain text). The theme's method and SQL follow
 * its layers. A link opens the explorer with the layer on the map
 * (#layer=<id>), and the page scrolls to #<id> on load.
 */

import { loadConfig } from './engine.js';
import { escapeHtml } from './format.js';

export async function createLayers({ root = null, base = '.', explorer = './' } = {}) {
    let el = typeof root === 'string' ? document.querySelector(root) : root;
    if (!el) el = document.getElementById('glen');
    if (!el) { el = document.createElement('main'); el.id = 'glen'; document.body.appendChild(el); }
    el.classList.add('layers-page');
    const style = document.createElement('style');
    style.textContent = layersCss;
    document.head.appendChild(style);
    try {
        const { app, themes } = await loadConfig(base);
        const docs = await Promise.all(themes.map(t => Promise.all((t.variables || []).map(v =>
            fetch(`${base}/${t.dir}/layers/${v.id}.md`, { cache: 'no-cache' }).then(r => (r.ok ? r.text() : null)).catch(() => null)))));
        // a layer is an h3, so its documentation's headings move down two levels (## → ####)
        const demote = text => text.replace(/^(#{1,4}) /gm, (m, h) => `${'#'.repeat(h.length + 2)} `);
        const md = text => (typeof marked !== 'undefined' ? marked.parse(demote(text)) : `<pre class="md-plain">${escapeHtml(text)}</pre>`);
        const dirText = (t, v) => (t.scored === false ? 'Not scored; shown as a matching covariate' : v.dir === -1 ? 'Lower is better' : 'Higher is better');
        const fact = (k, x) => (x ? `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(x))}</dd>` : '');
        el.innerHTML = `
            <nav class="layers-toc" aria-label="Layers">
                <a class="back" href="${escapeHtml(explorer)}">Back to the explorer</a>
                ${themes.map(t => `<div class="toc-theme" style="--c:${t.color || 'var(--primary)'}">${escapeHtml(t.label)}</div>
                    <ul>${(t.variables || []).map(v => `<li><a href="#${v.id}">${escapeHtml(v.label)}</a></li>`).join('')}</ul>`).join('')}
            </nav>
            <article class="layers-body">
                <h1>Data layers</h1>
                <p class="lede">Every layer that can be added to the basket in the ${escapeHtml(app.title || 'explorer')}, with what one value means, where the data come from and how a unit's value is computed. Each layer can be shown on the explorer's map with the layer picker or the link in its section.</p>
                ${themes.map((t, ti) => `
                <section class="layer-theme" style="--c:${t.color || 'var(--primary)'}">
                    <h2>${escapeHtml(t.label)}</h2>
                    ${t.blurb ? `<p class="theme-blurb">${escapeHtml(t.blurb)}</p>` : ''}
                    ${(t.variables || []).map((v, vi) => `
                    <section class="layer" id="${v.id}">
                        <h3>${escapeHtml(v.label)}</h3>
                        <dl class="facts">
                            ${fact('Source', v.source)}${fact('Resolution', v.resolution)}${fact('Unit', v.unit)}
                            ${fact('Direction', dirText(t, v))}${fact('Licence', v.licence)}${fact('Variable', v.id)}
                        </dl>
                        <a class="on-map" href="${escapeHtml(explorer)}#layer=${encodeURIComponent(v.id)}">Show on the map</a>
                        <div class="doc">${docs[ti][vi] ? md(docs[ti][vi]) : '<p class="missing">No documentation yet beyond the theme method below.</p>'}</div>
                    </section>`).join('')}
                    <details class="theme-method">
                        <summary>Method and SQL for ${escapeHtml(t.label.toLowerCase())}</summary>
                        ${t.method ? `<p>${escapeHtml(t.method)}</p>` : ''}
                        ${t.sql?.units ? `<pre>${escapeHtml(t.sql.units)}</pre>` : ''}
                    </details>
                </section>`).join('')}
            </article>`;
        document.title = `Data layers · ${app.title || 'Explorer'}`;
        const target = location.hash.slice(1) && document.getElementById(decodeURIComponent(location.hash.slice(1)));
        if (target) target.scrollIntoView();
    } catch (err) {
        console.error(err);
        el.innerHTML = `<div class="err">Failed to load the layers: ${escapeHtml(err.message)}</div>`;
    }
}

export const layersCss = `
.layers-page { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 28px; max-width: 1180px; margin: 0 auto; padding: 18px 16px 60px; }
.layers-toc { position: sticky; top: 12px; align-self: start; max-height: calc(100vh - 24px); overflow-y: auto; font-size: 13px; }
.layers-toc .back { display: inline-block; margin-bottom: 12px; }
.layers-toc .toc-theme { font-weight: 650; margin: 10px 0 4px; padding-left: 8px; border-left: 3px solid var(--c); }
.layers-toc ul { list-style: none; margin: 0; padding: 0 0 0 11px; }
.layers-toc li { margin: 3px 0; }
.layers-toc a { color: var(--text-2); text-decoration: none; }
.layers-toc a:hover { color: var(--primary); text-decoration: underline; }
.layers-body { min-width: 0; color: var(--text-2); line-height: 1.55; }
.layers-body h1 { color: var(--text); font-size: 24px; margin: 0 0 8px; }
.layers-body .lede { font-size: 15px; margin: 0 0 18px; }
.layer-theme { border-top: 3px solid var(--c); margin-top: 26px; padding-top: 6px; }
.layer-theme > h2 { color: var(--text); font-size: 19px; margin: 6px 0 4px; }
.theme-blurb { margin: 0 0 8px; }
.layer { scroll-margin-top: 12px; border-bottom: 1px solid var(--line); padding: 10px 0 14px; }
.layer h3 { color: var(--text); font-size: 16.5px; margin: 8px 0 8px; }
.layer h4 { color: var(--text); font-size: 14px; margin: 14px 0 4px; }
.layer .facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 14px; font-size: 13px; margin: 0 0 8px; }
.layer .facts dt { color: var(--text-3); }
.layer .facts dd { margin: 0; }
.layer .on-map { display: inline-block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.layer .doc p { margin: 0 0 8px; }
.layer .doc a { overflow-wrap: anywhere; }
.layer .doc code, .theme-method pre { background: var(--code-bg); border-radius: 4px; font-size: 12px; }
.layer .doc code { padding: 0 3px; overflow-wrap: anywhere; }
.layer .missing { color: var(--text-3); font-style: italic; }
.md-plain { white-space: pre-wrap; font: inherit; }
.theme-method { margin: 12px 0 0; font-size: 13px; }
.theme-method summary { cursor: pointer; font-weight: 600; color: var(--text); }
.theme-method pre { padding: 8px; overflow-x: auto; max-height: 420px; }
@media (max-width: 820px) {
  .layers-page { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .layers-toc { position: static; max-height: none; }
}
`;
