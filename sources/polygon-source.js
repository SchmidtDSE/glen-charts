/**
 * Area source: draw a polygon on the map or upload a GeoJSON file. Either
 * becomes an area by H3 polyfill on the query server (polygon.js), so every
 * theme's SQL runs unchanged. A drawn shape is not kept in the link.
 *
 *   createExplorer({ extensions: { sources: [polygonSource()] } })
 *
 * or, with no page script, in app.json:
 *   "area_sources": [{ "type": "polygon", "label": "Draw or upload an area", "kind_label": "Drawn area" }]
 *
 * compareWith: the area type a drawn area is ranked among (false for none);
 * by default the leaderboard's (see explorer.js).
 * res: 10 (default) fills the polygon at res 10; 8 fills at res 8 with no
 * {{AOI10}}, much faster on large areas for apps whose SQL reads only h8.
 */

import { DrawTool, readGeoJsonFile } from './draw.js';
import { polygonAoi } from './polygon.js';
import { escapeHtml } from '../core/format.js';

const HINT = 'Click to add points; double-click (or click the first point) to finish';

export function polygonSource({ id = 'draw', label = 'Draw / upload', description = 'Draw a polygon on the map or upload a GeoJSON file', kindLabel = 'Custom area', compareWith, res = 10 } = {}) {
    let draw = null, ctx = null, help = null;

    const use = (geoms, name) => {
        ctx.hideHint();
        help.textContent = '';
        ctx.select();                      // make this the active source if it is not
        ctx.mapView.showShape(geoms);
        const aoi = polygonAoi(geoms, name, { res });
        aoi.kindLabel = kindLabel;
        ctx.setAoi(aoi);
    };

    return {
        id,
        label,
        description,
        kindLabel,
        ...(compareWith !== undefined && { compareWith }),
        hashable: false,

        mount(step, c) {
            ctx = c;
            draw = new DrawTool(c.mapView, { onDone: geom => use([geom], 'Drawn area') });
            step.innerHTML = `
                <div class="step-label"><span class="step-num">2</span> Your area</div>
                <div class="draw-row">
                    <button class="ghost-btn" data-act="draw" type="button">Draw a polygon</button>
                    <label class="ghost-btn upload">Upload GeoJSON<input type="file" accept=".geojson,.json,application/geo+json,application/json" hidden></label>
                    <button class="ghost-btn" data-act="clear" type="button">Clear</button>
                </div>
                <div class="step-help"></div>`;
            help = step.querySelector('.step-help');
            step.querySelector('[data-act=draw]').onclick = () => { draw.start(); c.showHint(HINT); };
            step.querySelector('[data-act=clear]').onclick = () => { draw.cancel(); c.mapView.clearShape(); c.hideHint(); };
            step.querySelector('input[type=file]').onchange = async e => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                try {
                    use(await readGeoJsonFile(file), file.name.replace(/\.(geo)?json$/i, ''));
                } catch (err) {
                    help.textContent = err.message;
                }
            };
        },

        activate({ restoring = false } = {}) {
            if (!restoring) { draw.start(); ctx.showHint(HINT); }
        },

        deactivate() {
            draw?.cancel();
            ctx?.mapView.clearShape();
        },

        describe: () => escapeHtml(kindLabel),
    };
}
