// Modo «Cerca»: paradas a menos de un radio de un punto (una dirección, mi
// ubicación o un toque en el mapa) y las líneas que pasan por ellas.
/* global L */

import { NEARBY, ROUTING } from './config.js';
import { $, h, isMobile, formatMinutes, formatMeters } from './dom.js';
import { PointGrid } from './geo.js';
import { createPlaceInput, mapPlace } from './places.js';
import { reverseGeocode } from './geocode.js';
import { parsePoint } from './urlstate.js';

const BLUE = '#0b5cad';
const WALK_S_PER_M = (ROUTING.walkDetour * 3.6) / ROUTING.walkSpeedKmh;

export function initNearby(ctx) {
  const { map, data } = ctx;
  const grid = new PointGrid(data.stops, 300);

  const st = {
    active: false,
    center: null,            // lugar {lat, lon, name}
    radius: NEARBY.initial,
    hits: [],                // [{point: parada, dist}] dentro del radio
    lines: [],               // líneas que pasan por esas paradas
  };

  // --- Capas del mapa ---------------------------------------------------------
  const layer = L.layerGroup();
  let circle = null;
  let pin = null;
  const stopLayer = L.layerGroup().addTo(layer);

  // --- Formulario ---------------------------------------------------------------
  const input = createPlaceInput({
    label: 'Punto',
    placeholder: 'Calle, lugar o parada',
    marker: '',
    markerClass: 'c',
    stops: () => data.stops,
    lineNames: ctx.lineNames,
    near: () => { const c = map.getCenter(); return { lat: c.lat, lon: c.lng }; },
    onChange: (place) => setCenter(place, { fit: true, fromInput: true }),
    onPickOnMap: () => {
      if (isMobile()) ctx.setPanelCollapsed(true);
    },
  });
  const radiusLabel = h('output', { class: 'radius-value', for: 'radius', text: formatMeters(st.radius) });
  const slider = h('input', {
    type: 'range', id: 'radius', class: 'radius', min: NEARBY.min, max: NEARBY.max, step: NEARBY.step, value: st.radius,
    'aria-label': 'Radio de búsqueda en metros',
    oninput: () => {
      st.radius = Number(slider.value);
      radiusLabel.textContent = formatMeters(st.radius);
      refresh({ fit: false });
    },
    onchange: () => {
      refresh({ fit: true });
      ctx.updateUrl();
    },
  });
  $('#nearby-form').append(
    input.el,
    h('div', { class: 'radius-row' },
      h('label', { for: 'radius', text: 'Radio' }),
      h('span', { class: 'radius-min', text: formatMeters(NEARBY.min) }),
      slider,
      h('span', { class: 'radius-max', text: formatMeters(NEARBY.max) }),
      radiusLabel,
    ),
  );
  const resultsBox = $('#nearby-results');

  // --- Lógica -------------------------------------------------------------------
  function setCenter(place, { fit = true, fromInput = false } = {}) {
    st.center = place;
    if (!fromInput) input.set(place, { silent: true });
    if (place?.kind === 'map') {
      reverseGeocode(place.lat, place.lon).then((name) => {
        input.rename(place, name);
        if (st.center === place && name) {
          renderResults();
          ctx.updateUrl();
        }
      });
    }
    refresh({ fit });
    ctx.updateUrl();
  }

  function refresh({ fit }) {
    if (st.center) {
      st.hits = grid.within(st.center.lat, st.center.lon, st.radius);
      const ids = new Set(st.hits.flatMap((hit) => hit.point.lines));
      st.lines = data.lines.filter((line) => ids.has(line.id)); // en el orden natural de la lista
    } else {
      st.hits = [];
      st.lines = [];
    }
    renderResults();
    draw(fit);
    ctx.renderSummary();
  }

  function renderResults() {
    resultsBox.replaceChildren();
    if (!st.center) {
      resultsBox.append(h('div', { class: 'hint' },
        h('p', { text: 'Elige un punto para ver qué paradas y líneas tienes cerca: escribe una dirección, usa tu ubicación o toca el mapa.' }),
        h('button', { type: 'button', class: 'btn', onclick: () => input.el.querySelector('.place-locate').click(), text: 'Usar mi ubicación' }),
      ));
      return;
    }
    const nStops = st.hits.length;
    if (!nStops) {
      resultsBox.append(h('p', { class: 'notice', text: `No hay paradas de la EMT a menos de ${formatMeters(st.radius)} de este punto. Prueba a ampliar el radio.` }));
      return;
    }
    const nLines = st.lines.length;
    const painted = st.lines.filter((line) => ctx.isSelected(line.id)).length;
    resultsBox.append(
      h('p', { class: 'near-summary' },
        h('strong', { text: `${nStops} ${nStops === 1 ? 'parada' : 'paradas'}` }), ' y ',
        h('strong', { text: `${nLines} ${nLines === 1 ? 'línea' : 'líneas'}` }),
        ` a menos de ${formatMeters(st.radius)}`),
      h('div', { class: 'section-head' },
        h('h2', { class: 'section-title', text: 'Líneas' }),
        h('span', { class: 'near-actions' },
          painted < nLines ? h('button', {
            type: 'button', class: 'link',
            onclick: () => ctx.addLines(st.lines.map((line) => line.id)),
            text: painted ? 'Pintar el resto' : nLines === 1 ? 'Pintarla en el mapa' : 'Pintar todas en el mapa',
          }) : null,
          painted ? h('button', {
            type: 'button', class: 'link',
            onclick: () => ctx.removeLines(st.lines.map((line) => line.id)),
            text: 'Quitarlas',
          }) : null,
        ),
      ),
      h('div', { class: 'chips near-chips' }, st.lines.map(ctx.lineChip)),
      h('p', { class: 'hint-small', text: 'Pulsa una línea para pintarla en el mapa o quitarla.' }),
      h('h2', { class: 'section-title', text: 'Paradas, de la más cercana a la más lejana' }),
    );
    const list = h('ul', { class: 'stop-results' });
    for (const hit of st.hits) {
      const stop = hit.point;
      list.append(h('li', {},
        h('button', { type: 'button', class: 'stop-row', onclick: () => ctx.focusStop(stop) },
          h('span', { class: 'stop-code', text: stop.code }),
          h('span', { class: 'stop-text' },
            h('span', { class: 'stop-name', text: stop.name }),
            h('span', { class: 'stop-dist', text: `a ${formatMeters(hit.dist)} · ${formatMinutes(hit.dist * WALK_S_PER_M)} a pie` }),
            h('span', { class: 'stop-lines', text: ctx.lineNames(stop) }),
          ),
        )));
    }
    resultsBox.append(list);
  }

  function draw(fit) {
    stopLayer.clearLayers();
    if (!st.center) {
      if (circle) layer.removeLayer(circle);
      if (pin) layer.removeLayer(pin);
      circle = pin = null;
      return;
    }
    const at = [st.center.lat, st.center.lon];
    if (!circle) {
      circle = L.circle(at, {
        renderer: ctx.renderers.routes, pane: 'routes', interactive: false,
        radius: st.radius, color: BLUE, weight: 2, dashArray: '6 6', fillColor: BLUE, fillOpacity: 0.07,
      }).addTo(layer);
      pin = L.marker(at, {
        draggable: true, keyboard: false, title: 'Arrástralo para mover el punto',
        icon: L.divIcon({ className: 'pin pin-c', html: '', iconSize: [22, 22], iconAnchor: [11, 11] }),
      }).on('dragend', (e) => {
        const pos = e.target.getLatLng();
        setCenter(mapPlace(pos.lat, pos.lng), { fit: false });
      }).addTo(layer);
    } else {
      circle.setLatLng(at).setRadius(st.radius);
      pin.setLatLng(at);
    }
    for (const hit of st.hits) {
      const stop = hit.point;
      L.circleMarker([stop.lat, stop.lon], {
        renderer: ctx.renderers.journey, pane: 'journey', bubblingMouseEvents: false,
        radius: 6.5, color: BLUE, weight: 3, fillColor: '#fff', fillOpacity: 1,
      }).on('click', () => ctx.openStop(stop))
        .bindTooltip(`${stop.name} (nº ${stop.code})`, { direction: 'top', offset: [0, -6] })
        .addTo(stopLayer);
    }
    if (fit && st.active) map.fitBounds(circle.getBounds(), ctx.viewPadding());
    else if (fit) st.pendingFit = true; // se encuadrará al entrar en el modo
  }

  // --- Lo que usa app.js ----------------------------------------------------------
  return {
    /** Un toque en el mapa mueve el punto. */
    onMapClick(latlng) {
      setCenter(mapPlace(latlng.lat, latlng.lng), { fit: false });
      if (isMobile()) ctx.setPanelCollapsed(false);
      return true;
    },

    /** Han cambiado las líneas pintadas: hay que actualizar sus chips. */
    onSelection() {
      if (st.center) renderResults();
    },

    activate() {
      st.active = true;
      layer.addTo(map);
      if (st.center) draw(Boolean(st.pendingFit));
      st.pendingFit = false;
    },

    deactivate() {
      st.active = false;
      layer.remove();
    },

    summary() {
      if (!st.center) return [h('span', { class: 'summary-text', text: 'Cerca' })];
      const n = st.hits.length;
      return [h('span', { class: 'summary-text', text: `${n} ${n === 1 ? 'parada' : 'paradas'} a ${formatMeters(st.radius)}` })];
    },

    urlParams() {
      const c = st.center;
      return { c: c ? `${c.lat.toFixed(5)},${c.lon.toFixed(5)},${st.radius},${c.name}` : null };
    },

    applyParams(params, keepView) {
      if ((params.c || null) === this.urlParams().c) return; // nada nuevo
      const point = parsePoint(params.c);
      if (!point) {
        setCenter(null, { fit: false });
        return;
      }
      const radius = Number(point.rest[0]);
      if (radius >= NEARBY.min && radius <= NEARBY.max) st.radius = radius;
      slider.value = st.radius;
      radiusLabel.textContent = formatMeters(st.radius);
      setCenter({
        lat: point.lat, lon: point.lon, name: point.rest.slice(1).join(',') || 'Punto del mapa', kind: 'address',
      }, { fit: !keepView });
    },
  };
}
