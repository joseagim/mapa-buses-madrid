// Mapa de buses de Madrid: lógica principal (datos, mapa y panel).
/* global L */

import { NETWORK, HOME, PALETTE, ZOOM, TRANSFER_RADIUS_M, EXAMPLE_LINES } from './config.js';
import { decodePolyline, metersPerPixel, normalizeText, textColorFor } from './geo.js';
import { buildTrack, computeLanes, lanesToOffsets, offsetPath } from './offset.js';
import { computeTransfers } from './transfers.js';
import { parseHash, buildHash } from './urlstate.js';

const NAVY = '#0b2545';
const DIR_LABEL = { 0: 'Ida', 1: 'Vuelta' };

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

/** Datos cargados de data/<red>/ */
const data = {
  feed: null,
  lines: [],              // [{id, name, long, dirs, search}]
  lineById: new Map(),
  lineByName: new Map(),  // nombre corto en mayúsculas -> línea
  stops: [],              // [{id, code, name, lat, lon, lines:[id], search}]
  stopById: new Map(),
  lineFiles: new Map(),   // id -> Promise con el fichero de la línea ya preparado
};

/** Lo que ha elegido el usuario. */
const state = {
  selected: [],           // [{id, color, dir}]  dir: 'b' ambos, 'i' ida, 'v' vuelta
  showTransfers: true,
  openStop: null,         // parada con el popup abierto
};

/** Lo que hay dibujado ahora mismo (se recalcula en syncMap). */
let current = {
  display: [],            // recorridos visibles: [{sel, order, dir}]
  stopInfo: new Map(),    // id de parada -> {stop, colors:Set}
  transfers: [],          // resultado de computeTransfers
  shared: new Map(),      // id -> parada compartida
  near: new Map(),        // id -> parada con otra cercana
  links: [],              // [{a, b, dist}] parejas de paradas cercanas
};

// ---------------------------------------------------------------------------
// Utilidades de DOM
// ---------------------------------------------------------------------------

const $ = (selector) => document.querySelector(selector);

/** Crea un elemento: h('button', {class: 'x', onclick: fn}, 'texto', otroElemento) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'style') el.style.cssText = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) el.append(child);
  }
  return el;
}

const isMobile = () => window.matchMedia('(max-width: 700px)').matches;

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

// ---------------------------------------------------------------------------
// Mapa
// ---------------------------------------------------------------------------

const map = L.map('map', {
  zoomControl: false,
  minZoom: 10,
  maxZoom: 19,
  maxBounds: [[39.6, -4.9], [41.3, -2.7]],
}).setView(HOME.center, HOME.zoom);

L.control.zoom({ position: 'topright', zoomInTitle: 'Acercar', zoomOutTitle: 'Alejar' }).addTo(map);
map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');

// Mapa base: teselas estándar de OpenStreetMap (gratis y sin API key).
// En css/style.css se les baja el color para que destaquen las líneas.
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution:
    '<a href="https://www.emtmadrid.es" target="_blank" rel="noopener">Powered by EMT de Madrid</a>'
    + ' (<a href="https://mobilitylabs.emtmadrid.es/sip/terms-of-use" target="_blank" rel="noopener">condiciones</a>)'
    + ' · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">colaboradores de OpenStreetMap</a>',
}).addTo(map);

// Capas, de abajo arriba: borde blanco de las líneas, líneas, enlaces de
// transbordo y paradas. Solo las paradas reciben clics.
for (const [name, zIndex, interactive] of [
  ['casing', 410, false], ['routes', 420, false], ['links', 430, false], ['stops', 440, true],
]) {
  const pane = map.createPane(name);
  pane.style.zIndex = zIndex;
  if (!interactive) pane.style.pointerEvents = 'none';
}
const casingRenderer = L.svg({ pane: 'casing', padding: 0.5 });
const routeRenderer = L.svg({ pane: 'routes', padding: 0.5 });
const linkRenderer = L.svg({ pane: 'links', padding: 0.5 });
const stopRenderer = L.canvas({ pane: 'stops', padding: 0.3, tolerance: 7 });

const casingGroup = L.layerGroup().addTo(map);
const routeGroup = L.layerGroup().addTo(map);
const linkGroup = L.layerGroup().addTo(map);
const stopGroup = L.layerGroup().addTo(map);

const popup = L.popup({ maxWidth: 280, minWidth: 200, autoPanPadding: [16, 16] });
map.on('popupclose', (e) => {
  if (e.popup === popup) state.openStop = null;
});

/** Márgenes para que fitBounds no deje nada debajo del panel. */
function viewPadding() {
  const panel = $('#panel');
  const collapsed = panel.classList.contains('collapsed');
  if (isMobile()) {
    const covered = collapsed ? $('#panel-head').offsetHeight : panel.offsetHeight;
    return { paddingTopLeft: [24, 24], paddingBottomRight: [24, covered + 24] };
  }
  const left = collapsed ? 24 : panel.offsetWidth + 36;
  return { paddingTopLeft: [left, 24], paddingBottomRight: [56, 36] };
}

// ---------------------------------------------------------------------------
// Carga de datos
// ---------------------------------------------------------------------------

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function loadBaseData() {
  const [index, stopsFile] = await Promise.all([
    fetchJson(`${NETWORK.path}/index.json`),
    fetchJson(`${NETWORK.path}/stops.json`),
  ]);
  data.feed = index.feed;
  data.lines = index.lines.map((line) => ({
    ...line,
    nameNorm: normalizeText(line.name),
    search: normalizeText([line.name, line.long, ...line.dirs.map((d) => d.headsign)].join(' ')),
  }));
  for (const line of data.lines) {
    data.lineById.set(line.id, line);
    data.lineByName.set(line.name.toUpperCase(), line);
  }
  data.stops = stopsFile.stops.map(([id, code, name, lat, lon, lines]) => ({
    id, code, name, lat, lon, lines,
    search: normalizeText(`${code} ${name}`),
  }));
  for (const stop of data.stops) data.stopById.set(stop.id, stop);
}

/** Carga (una sola vez) el fichero de una línea y prepara su geometría. */
function loadLine(id) {
  if (!data.lineFiles.has(id)) {
    const promise = fetchJson(`${NETWORK.path}/lines/${id}.json`).then((file) => {
      for (const dir of file.dirs) {
        dir.track = buildTrack(decodePolyline(dir.shape));
        dir.stopObjs = dir.stops.map((stopId) => data.stopById.get(stopId)).filter(Boolean);
      }
      return file;
    });
    promise.catch(() => data.lineFiles.delete(id)); // si falla, se podrá reintentar
    data.lineFiles.set(id, promise);
  }
  return data.lineFiles.get(id);
}

// ---------------------------------------------------------------------------
// Selección de líneas
// ---------------------------------------------------------------------------

const isSelected = (id) => state.selected.some((s) => s.id === id);
const selectionOf = (id) => state.selected.find((s) => s.id === id);

function nextColor() {
  const used = new Set(state.selected.map((s) => s.color));
  return PALETTE.find((c) => !used.has(c)) || PALETTE[state.selected.length % PALETTE.length];
}

function addLines(ids) {
  const added = [];
  for (const id of ids) {
    if (!data.lineById.has(id) || isSelected(id)) continue;
    state.selected.push({ id, color: nextColor(), dir: 'b' });
    added.push(id);
  }
  if (added.length) selectionChanged({ reveal: added });
}

function removeLine(id) {
  state.selected = state.selected.filter((s) => s.id !== id);
  selectionChanged();
}

function toggleLine(id) {
  if (isSelected(id)) removeLine(id);
  else addLines([id]);
}

function clearLines() {
  state.selected = [];
  selectionChanged();
}

/** Hay que llamarla siempre que cambie la lista de líneas seleccionadas. */
async function selectionChanged({ reveal = null, fitAll = false } = {}) {
  renderSelected();
  renderLineList();
  renderSummary();
  updateUrl();
  await syncMap();
  if (fitAll) fitToLines(state.selected.map((s) => s.id), false);
  else if (reveal) fitToLines(reveal, true);
}

/** Cambios que no alteran la lista (color o sentido de una línea). */
function selectionEdited() {
  renderLineList();
  renderSummary();
  updateUrl();
  syncMap();
}

// ---------------------------------------------------------------------------
// Dibujo en el mapa
// ---------------------------------------------------------------------------

let syncCounter = 0;

/** Carga lo que falte y redibuja líneas, paradas y transbordos. */
async function syncMap() {
  const ticket = ++syncCounter;
  let files;
  try {
    files = await Promise.all(state.selected.map((s) => loadLine(s.id)));
  } catch (error) {
    console.error(error);
    toast('No se han podido cargar los datos de alguna línea.');
    return;
  }
  if (ticket !== syncCounter) return; // ya hay una petición más reciente

  const display = [];
  const stopInfo = new Map();
  const lineStops = [];
  state.selected.forEach((sel, order) => {
    const stops = new Map();
    for (const dir of files[order].dirs) {
      const wanted = sel.dir === 'b' || (sel.dir === 'i' ? dir.dir === 0 : dir.dir === 1);
      if (!wanted) continue;
      display.push({ sel, order, dir });
      for (const stop of dir.stopObjs) {
        stops.set(stop.id, stop);
        if (!stopInfo.has(stop.id)) stopInfo.set(stop.id, { stop, colors: new Set() });
        stopInfo.get(stop.id).colors.add(sel.color);
      }
    }
    lineStops.push({ id: sel.id, stops: [...stops.values()] });
  });

  const transfers = lineStops.length >= 2 ? computeTransfers(lineStops, TRANSFER_RADIUS_M) : [];
  const shared = new Map();
  const near = new Map();
  const links = new Map();
  for (const pair of transfers) {
    for (const stop of pair.shared) shared.set(stop.id, stop);
    for (const link of pair.near) {
      near.set(link.a.id, link.a);
      near.set(link.b.id, link.b);
      const key = [link.a.id, link.b.id].sort().join('|');
      links.set(key, link);
    }
  }
  current = { display, stopInfo, transfers, shared, near, links: [...links.values()] };

  drawRoutes();
  drawStops();
  renderTransfers();
  refreshPopup();
}

function lineWeight(zoom) {
  if (zoom <= 11) return 2.5;
  if (zoom === 12) return 3;
  if (zoom <= 14) return 4;
  return 5;
}

/** Dibuja los recorridos visibles, desplazados para que no se tapen. */
function drawRoutes() {
  casingGroup.clearLayers();
  routeGroup.clearLayers();
  const { display } = current;
  if (!display.length) return;

  const zoom = map.getZoom();
  const weight = lineWeight(zoom);
  const spacing = weight + 1;
  // A poco zoom, dos calles paralelas muy próximas se pintarían una encima de
  // otra: se tratan como la misma calle (hasta 50 m).
  const radius = Math.min(50, Math.max(22, spacing * metersPerPixel(zoom)));
  const lanes = computeLanes(display.map((d) => ({ order: d.order, track: d.dir.track })), radius);

  display.forEach((item, k) => {
    const track = item.dir.track;
    const offsets = lanesToOffsets(lanes[k], spacing);
    const xs = new Float64Array(track.n);
    const ys = new Float64Array(track.n);
    for (let i = 0; i < track.n; i++) {
      const p = map.project([track.lat[i], track.lon[i]], zoom);
      xs[i] = p.x;
      ys[i] = p.y;
    }
    const latlngs = offsetPath(xs, ys, offsets).map(([x, y]) => map.unproject([x, y], zoom));
    L.polyline(latlngs, {
      renderer: casingRenderer, pane: 'casing', interactive: false,
      color: '#fff', weight: weight + 2.5, opacity: 0.9, lineJoin: 'round',
    }).addTo(casingGroup);
    L.polyline(latlngs, {
      renderer: routeRenderer, pane: 'routes', interactive: false,
      color: item.sel.color, weight, opacity: 1, lineJoin: 'round',
    }).addTo(routeGroup);
  });
}

function addStopMarker(stop, style) {
  L.circleMarker([stop.lat, stop.lon], {
    renderer: stopRenderer, pane: 'stops', bubblingMouseEvents: false,
    fillOpacity: 1, ...style,
  }).on('click', () => openStop(stop)).addTo(stopGroup);
}

/** Dibuja las paradas visibles y los puntos de transbordo. */
function drawStops() {
  stopGroup.clearLayers();
  linkGroup.clearLayers();
  const zoom = map.getZoom();
  const bounds = map.getBounds().pad(0.3);
  const inView = (s) => bounds.contains([s.lat, s.lon]);
  const base = zoom <= 12 ? 2.5 : zoom === 13 ? 3 : zoom === 14 ? 3.5 : zoom === 15 ? 4.5 : 5.5;
  const showTransfers = state.showTransfers && zoom >= ZOOM.transfers && current.transfers.length > 0;
  const highlighted = (id) => showTransfers && (current.shared.has(id) || current.near.has(id));

  // 1) Resto de paradas de la red (solo con mucho zoom)
  if (zoom >= ZOOM.allStops) {
    for (const stop of data.stops) {
      if (current.stopInfo.has(stop.id) || !inView(stop)) continue;
      addStopMarker(stop, { radius: base - 1, color: '#7c98b6', weight: 1.5, fillColor: '#fff' });
    }
  }

  // 2) Paradas de las líneas seleccionadas
  if (zoom >= ZOOM.lineStops) {
    for (const [id, info] of current.stopInfo) {
      if (highlighted(id) || !inView(info.stop)) continue;
      const color = info.colors.size === 1 ? [...info.colors][0] : NAVY;
      addStopMarker(info.stop, { radius: base, color, weight: 2, fillColor: '#fff' });
    }
  }

  // 3) Transbordos: enlaces entre paradas cercanas y paradas compartidas
  if (showTransfers) {
    for (const link of current.links) {
      if (!inView(link.a) && !inView(link.b)) continue;
      L.polyline([[link.a.lat, link.a.lon], [link.b.lat, link.b.lon]], {
        renderer: linkRenderer, pane: 'links', interactive: false,
        color: NAVY, weight: zoom >= 15 ? 3 : 2, dashArray: '1 6', lineCap: 'round',
      }).addTo(linkGroup);
    }
    for (const [id, stop] of current.near) {
      if (current.shared.has(id) || !inView(stop)) continue;
      addStopMarker(stop, { radius: base + 1, color: NAVY, weight: 2, fillColor: '#ffe9a3' });
    }
    for (const stop of current.shared.values()) {
      if (!inView(stop)) continue;
      addStopMarker(stop, { radius: base + 2.5, color: NAVY, weight: 2.5, fillColor: '#ffd60a' });
    }
  }
}

function fitToLines(ids, onlyIfOutside) {
  const wanted = new Set(ids);
  const bounds = L.latLngBounds([]);
  for (const item of current.display) {
    if (!wanted.has(item.sel.id)) continue;
    const { lat, lon, n } = item.dir.track;
    for (let i = 0; i < n; i += 5) bounds.extend([lat[i], lon[i]]);
  }
  if (!bounds.isValid()) return;
  if (onlyIfOutside && map.getBounds().intersects(bounds)) return;
  map.fitBounds(bounds, viewPadding());
}

map.on('zoomend', () => {
  drawRoutes();
});
map.on('moveend', () => {
  drawStops();
  updateUrl();
});

// ---------------------------------------------------------------------------
// Paradas: popup y buscador
// ---------------------------------------------------------------------------

function lineChip(line) {
  const sel = selectionOf(line.id);
  return h('button', {
    type: 'button',
    class: 'badge chip' + (sel ? ' on' : ''),
    style: sel ? `background:${sel.color};color:${textColorFor(sel.color)}` : null,
    title: `${line.name} · ${line.long}` + (sel ? ' (pulsa para quitarla)' : ' (pulsa para seleccionarla)'),
    'aria-pressed': sel ? 'true' : 'false',
    onclick: () => toggleLine(line.id),
    text: line.name,
  });
}

function stopPopupContent(stop) {
  const lines = stop.lines.map((id) => data.lineById.get(id)).filter(Boolean);
  const missing = lines.filter((l) => !isSelected(l.id));
  return h('div', { class: 'stop-popup' },
    h('div', { class: 'sp-name', text: stop.name }),
    h('div', { class: 'sp-code', text: `Parada nº ${stop.code}` }),
    h('div', { class: 'sp-label', text: lines.length === 1 ? 'Pasa 1 línea:' : `Pasan ${lines.length} líneas:` }),
    h('div', { class: 'chips' }, lines.map(lineChip)),
    h('button', {
      type: 'button',
      class: 'btn primary',
      disabled: missing.length === 0,
      onclick: () => addLines(missing.map((l) => l.id)),
      text: missing.length === 0
        ? 'Todas seleccionadas ✓'
        : lines.length === 1 ? 'Seleccionar esta línea'
          : missing.length === lines.length ? `Seleccionar las ${lines.length} líneas`
            : missing.length === 1 ? 'Seleccionar la que falta' : `Seleccionar las ${missing.length} que faltan`,
    }),
  );
}

function openStop(stop) {
  // que el popup no quede debajo del panel
  const padding = viewPadding();
  popup.options.autoPanPaddingTopLeft = L.point(isMobile() ? [12, 12] : [padding.paddingTopLeft[0] - 12, 12]);
  popup.options.autoPanPaddingBottomRight = L.point(isMobile() ? [12, padding.paddingBottomRight[1] - 12] : [56, 28]);
  popup.setLatLng([stop.lat, stop.lon]).setContent(stopPopupContent(stop)).openOn(map);
  state.openStop = stop;
}

function refreshPopup() {
  if (state.openStop && map.hasLayer(popup)) popup.setContent(stopPopupContent(state.openStop));
}

/** Centra el mapa en una parada y abre su popup. */
function focusStop(stop) {
  if (isMobile()) setPanelCollapsed(true);
  map.once('moveend', () => openStop(stop));
  map.fitBounds(L.latLngBounds([[stop.lat, stop.lon]]), {
    ...viewPadding(), maxZoom: Math.max(map.getZoom(), ZOOM.stopFocus),
  });
}

function renderStopResults() {
  const list = $('#stop-results');
  const query = normalizeText($('#stop-search').value);
  list.replaceChildren();
  if (query.length < 2) {
    list.append(h('li', { class: 'empty', text: 'Escribe al menos 2 caracteres: un nombre («Cibeles», «Atocha») o el código de la parada.' }));
    return;
  }
  const tokens = query.split(/\s+/);
  const matches = [];
  for (const stop of data.stops) {
    if (!tokens.every((t) => stop.search.includes(t))) continue;
    // primero el código exacto, luego los que empiezan por el texto buscado
    const score = stop.code === query ? 0 : stop.code.startsWith(query) ? 1 : normalizeText(stop.name).startsWith(query) ? 2 : 3;
    matches.push([score, stop]);
  }
  matches.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name, 'es') || a[1].code.localeCompare(b[1].code, 'es', { numeric: true }));
  if (!matches.length) {
    list.append(h('li', { class: 'empty', text: 'No hay paradas que coincidan.' }));
    return;
  }
  const MAX = 60;
  for (const [, stop] of matches.slice(0, MAX)) {
    const names = stop.lines.map((id) => data.lineById.get(id)?.name).filter(Boolean);
    list.append(h('li', {},
      h('button', { type: 'button', class: 'stop-row', onclick: () => focusStop(stop) },
        h('span', { class: 'stop-code', text: stop.code }),
        h('span', { class: 'stop-text' },
          h('span', { class: 'stop-name', text: stop.name }),
          h('span', { class: 'stop-lines', text: names.join(' · ') }),
        ),
      ),
    ));
  }
  if (matches.length > MAX) {
    list.append(h('li', { class: 'empty', text: `Hay ${matches.length - MAX} paradas más: afina la búsqueda.` }));
  }
}

// ---------------------------------------------------------------------------
// Panel: líneas
// ---------------------------------------------------------------------------

function badge(line, color) {
  return h('span', {
    class: 'badge',
    style: color ? `background:${color};color:${textColorFor(color)}` : null,
    text: line.name,
  });
}

function searchLines(text) {
  const query = normalizeText(text);
  if (!query) return data.lines;
  const tokens = query.split(/\s+/);
  const scored = [];
  for (const line of data.lines) {
    if (!tokens.every((t) => line.search.includes(t))) continue;
    const score = line.nameNorm === query ? 0 : line.nameNorm.startsWith(query) ? 1 : line.nameNorm.includes(query) ? 2 : 3;
    scored.push([score, line]);
  }
  scored.sort((a, b) => a[0] - b[0]); // el orden es estable: a igualdad, orden natural
  return scored.map(([, line]) => line);
}

function renderLineList() {
  const list = $('#line-list');
  const query = $('#line-search').value;
  const lines = searchLines(query);
  $('#line-list-title').textContent = query.trim()
    ? `Resultados (${lines.length})`
    : `Todas las líneas (${lines.length})`;
  list.replaceChildren();
  if (!lines.length) {
    list.append(h('li', { class: 'empty', text: 'No hay líneas que coincidan.' }));
    return;
  }
  for (const line of lines) {
    const sel = selectionOf(line.id);
    list.append(h('li', {},
      h('button', {
        type: 'button',
        class: 'line-row' + (sel ? ' on' : ''),
        'aria-pressed': sel ? 'true' : 'false',
        onclick: () => toggleLine(line.id),
      },
      badge(line, sel?.color),
      h('span', { class: 'line-long', text: line.long }),
      h('span', { class: 'check', 'aria-hidden': 'true', text: sel ? '✓' : '+' }),
      ),
    ));
  }
}

function directionSelect(sel, line) {
  const select = h('select', {
    class: 'dir-select',
    'aria-label': `Sentido de la línea ${line.name}`,
    onchange: (e) => {
      sel.dir = e.target.value;
      selectionEdited();
    },
  });
  select.append(h('option', { value: 'b', text: 'Ambos sentidos' }));
  for (const dir of line.dirs) {
    const value = dir.dir === 0 ? 'i' : 'v';
    select.append(h('option', { value, text: `${DIR_LABEL[dir.dir]} → ${dir.headsign || '?'}` }));
  }
  select.value = sel.dir;
  return select;
}

function renderSelected() {
  const box = $('#selected-box');
  box.replaceChildren();
  if (!state.selected.length) {
    box.append(h('div', { class: 'hint' },
      h('p', { text: 'Elige líneas en la lista para verlas en el mapa. Con dos o más verás dónde se cruzan para hacer transbordo.' }),
      h('button', {
        type: 'button', class: 'btn',
        onclick: () => addLines(EXAMPLE_LINES.map((n) => data.lineByName.get(n)?.id).filter(Boolean)),
        text: `Probar con ${EXAMPLE_LINES.join(', ')}`,
      }),
    ));
    return;
  }
  box.append(h('div', { class: 'section-head' },
    h('h2', { class: 'section-title', text: `Seleccionadas (${state.selected.length})` }),
    h('button', { type: 'button', class: 'link', onclick: clearLines, text: 'Quitar todas' }),
  ));
  const list = h('ul', { class: 'selected-list' });
  for (const sel of state.selected) {
    const line = data.lineById.get(sel.id);
    const lineBadge = badge(line, sel.color);
    const color = h('input', {
      type: 'color', class: 'color', value: sel.color,
      title: 'Cambiar color', 'aria-label': `Color de la línea ${line.name}`,
      oninput: (e) => {
        sel.color = e.target.value.toLowerCase();
        lineBadge.style.background = sel.color;
        lineBadge.style.color = textColorFor(sel.color);
        selectionEditedSoon();
      },
    });
    list.append(h('li', { class: 'selected-row' },
      color,
      h('div', { class: 'selected-main' },
        h('div', { class: 'selected-name' }, lineBadge, h('span', { class: 'line-long', text: line.long })),
        directionSelect(sel, line),
      ),
      h('button', {
        type: 'button', class: 'icon', title: 'Centrar el mapa en la línea',
        'aria-label': `Centrar el mapa en la línea ${line.name}`,
        onclick: () => {
          if (isMobile()) setPanelCollapsed(true);
          fitToLines([sel.id], false);
        },
      }, h('span', { class: 'ico-target', 'aria-hidden': 'true' })),
      h('button', {
        type: 'button', class: 'icon', title: 'Quitar línea', 'aria-label': `Quitar la línea ${line.name}`,
        onclick: () => removeLine(sel.id), text: '×',
      }),
    ));
  }
  box.append(list);
}

const selectionEditedSoon = debounce(selectionEdited, 60);

/** Resumen en la cabecera (se ve con el panel plegado). */
function renderSummary() {
  const box = $('#summary');
  box.replaceChildren();
  for (const sel of state.selected) box.append(badge(data.lineById.get(sel.id), sel.color));
}

// ---------------------------------------------------------------------------
// Panel: transbordos
// ---------------------------------------------------------------------------

function focusLink(link) {
  if (isMobile()) setPanelCollapsed(true);
  map.fitBounds(L.latLngBounds([[link.a.lat, link.a.lon], [link.b.lat, link.b.lon]]), {
    ...viewPadding(), maxZoom: ZOOM.stopFocus,
  });
}

function renderTransfers() {
  const box = $('#transfers-box');
  const counter = $('#transfer-count');
  box.replaceChildren();
  const total = current.shared.size + current.links.length;
  counter.hidden = state.selected.length < 2;
  counter.textContent = total;

  if (state.selected.length < 2) {
    box.append(h('p', { class: 'empty', text: 'Selecciona dos o más líneas para ver dónde puedes hacer transbordo entre ellas.' }));
    return;
  }

  box.append(
    h('label', { class: 'toggle' },
      h('input', {
        type: 'checkbox', checked: state.showTransfers,
        onchange: (e) => {
          state.showTransfers = e.target.checked;
          drawStops();
        },
      }),
      'Resaltar los transbordos en el mapa'),
    h('div', { class: 'legend' },
      h('span', {}, h('i', { class: 'dot shared' }), 'Misma parada'),
      h('span', {}, h('i', { class: 'dot near' }), h('i', { class: 'dash' }), h('i', { class: 'dot near' }),
        `Paradas a menos de ${TRANSFER_RADIUS_M} m`),
    ),
  );

  for (const pair of current.transfers) {
    const lineA = data.lineById.get(pair.a);
    const lineB = data.lineById.get(pair.b);
    const count = pair.shared.length + pair.near.length;
    const details = h('details', { class: 'pair', open: current.transfers.length <= 3 && count > 0 },
      h('summary', {},
        badge(lineA, selectionOf(pair.a)?.color),
        h('span', { class: 'arrow', text: '↔' }),
        badge(lineB, selectionOf(pair.b)?.color),
        h('span', { class: 'pair-count', text: count === 0 ? 'sin transbordo' : count === 1 ? '1 punto' : `${count} puntos` }),
      ),
    );
    if (count === 0) {
      details.append(h('p', { class: 'empty', text: `Estas líneas no tienen paradas a menos de ${TRANSFER_RADIUS_M} m (con los sentidos elegidos).` }));
    } else {
      const list = h('ul', { class: 'transfer-list' });
      for (const stop of pair.shared) {
        list.append(h('li', {},
          h('button', { type: 'button', class: 'transfer-row', onclick: () => focusStop(stop) },
            h('i', { class: 'dot shared' }),
            h('span', {}, h('strong', { text: stop.name }), h('small', { text: ` nº ${stop.code} · misma parada` })),
          )));
      }
      for (const link of pair.near) {
        list.append(h('li', {},
          h('button', { type: 'button', class: 'transfer-row', onclick: () => focusLink(link) },
            h('i', { class: 'dot near' }),
            h('span', {},
              h('strong', { text: link.a.name }), h('small', { text: ` nº ${link.a.code}` }),
              h('span', { class: 'arrow', text: ' ↔ ' }),
              h('strong', { text: link.b.name }), h('small', { text: ` nº ${link.b.code} · a ${Math.round(link.dist / 10) * 10 || 10} m` }),
            ),
          )));
      }
      details.append(list);
    }
    box.append(details);
  }
}

// ---------------------------------------------------------------------------
// Panel: pestañas y plegado
// ---------------------------------------------------------------------------

function setPanelCollapsed(collapsed) {
  $('#panel').classList.toggle('collapsed', collapsed);
  $('#panel-toggle').setAttribute('aria-expanded', String(!collapsed));
}

function showTab(name) {
  for (const button of document.querySelectorAll('.tabs [data-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === name));
  }
  for (const section of document.querySelectorAll('.tab')) {
    section.hidden = section.id !== `tab-${name}`;
  }
}

function setupPanel() {
  $('#panel-toggle').addEventListener('click', () => {
    setPanelCollapsed(!$('#panel').classList.contains('collapsed'));
  });
  for (const button of document.querySelectorAll('.tabs [data-tab]')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }
  $('#line-search').addEventListener('input', renderLineList);
  $('#line-search').addEventListener('keydown', (e) => {
    // Enter selecciona el primer resultado
    if (e.key !== 'Enter' || !e.target.value.trim()) return;
    const [first] = searchLines(e.target.value);
    if (first && !isSelected(first.id)) addLines([first.id]);
  });
  $('#stop-search').addEventListener('input', debounce(renderStopResults, 120));
  // En móvil, al tocar el mapa se pliega el panel para ver mejor.
  map.on('click', () => {
    if (isMobile()) setPanelCollapsed(true);
  });
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

let lastHash = null;

const updateUrl = debounce(() => {
  const center = map.getCenter();
  const hash = buildHash(
    state.selected.map((s) => ({ name: data.lineById.get(s.id).name, color: s.color, dir: s.dir })),
    { zoom: map.getZoom(), lat: center.lat, lng: center.lng },
  );
  lastHash = hash;
  history.replaceState(null, '', hash || location.pathname + location.search);
}, 250);

/** Aplica el estado de la URL. Devuelve true si la URL traía una vista de mapa. */
function applyHash() {
  const parsed = parseHash(location.hash);
  state.selected = [];
  for (const item of parsed.lines) {
    const line = data.lineByName.get(item.name.toUpperCase());
    if (!line || isSelected(line.id)) continue;
    state.selected.push({ id: line.id, color: item.color || nextColor(), dir: item.dir });
  }
  if (parsed.view) map.setView([parsed.view.lat, parsed.view.lng], parsed.view.zoom, { animate: false });
  return Boolean(parsed.view);
}

window.addEventListener('hashchange', () => {
  if (location.hash === lastHash) return; // el cambio lo hemos hecho nosotros
  const hadView = applyHash();
  selectionChanged({ fitAll: !hadView });
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

async function main() {
  setupPanel();
  try {
    await loadBaseData();
  } catch (error) {
    console.error(error);
    $('#selected-box').append(h('p', { class: 'empty', text: 'No se han podido cargar los datos. Si has abierto el fichero directamente, usa un servidor local (mira el README).' }));
    return;
  }
  if (data.feed?.date) {
    const [y, m, d] = data.feed.date.split('-');
    $('#feed-date').textContent = ` (actualizado el ${d}/${m}/${y})`;
  }
  const hadView = applyHash();
  if (isMobile() && state.selected.length) setPanelCollapsed(true);
  renderStopResults();
  await selectionChanged({ fitAll: !hadView && state.selected.length > 0 });
}

main();
