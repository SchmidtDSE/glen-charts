/**
 * Area source: draw a polygon on the map or upload a GeoJSON file. Either
 * becomes an area by H3 polyfill on the query server (polygon.js), so every
 * theme's SQL runs unchanged. A drawn shape is not kept in the link.
 *
 *   createExplorer({ sources: [polygonSource()] })
 */

import { DrawTool, readGeoJsonFile } from './draw.js';
import { polygonAoi } from './polygon.js';
import { escapeHtml } from '../core/format.js';

const HINT = 'Click to add points; double-click (or click the first point) to finish';

export function polygonSource({ label = 'Draw / upload', description = 'Draw a polygon on the map or upload a GeoJSON file', kindLabel = 'Custom area' } = {}) {
    let draw = null, ctx = null, help = null;

    const use = (geoms, name) => {
        ctx.hideHint();
        help.textContent = '';
        ctx.select();                      // make this the active source if it is not
        ctx.mapView.showShape(geoms);
        const aoi = polygonAoi(geoms, name);
        aoi.kindLabel = kindLabel;
        ctx.setAoi(aoi);
    };

    return {
        id: 'draw',
        label,
        description,
        kindLabel,
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
