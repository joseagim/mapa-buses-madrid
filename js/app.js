// Mapa de buses de Madrid: lógica principal (datos, mapa y panel).
/* global L */

import { NETWORKS, HOME, PALETTE, ZOOM, TRANSFER_RADIUS_M, EXAMPLE_LINES } from './config.js';
import { decodePolyline, metersPerPixel, normalizeText } from './geo.js';
import { buildTrack, computeLanes, lanesToOffsets, offsetPath } from './offset.js';
import { computeTransfers } from './transfers.js';
import { parseHash, buildHash } from './urlstate.js';
import { $, h, isMobile, debounce, toast } from './dom.js';
import { searchStops, stopPlace } from './places.js';
import { createStore, loadIndex, loadStops, fetchJson, lineUrlPath, lineToUrl } from './data.js';
import { setupSheet, setSheet, setPanelCollapsed, sheetHeights } from './sheet.js';
import { initPlanner } from './planner.js';
import { initNearby } from './nearby.js';

const NAVY = '#0b2545';
const DIR_LABEL = { 0: 'Ida', 1: 'Vuelta' };
const NET_BY_ID = new Map(NETWORKS.map((net) => [net.id, net]));

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

/** Datos cargados de data/<red>/ (ver js/data.js). */
const data = createStore();
data.lineFiles = new Map();   // id de línea -> Promise con su fichero ya preparado

/** Lo que ha elegido el usuario. */
const state = {
  mode: 'lines',          // 'lines' | 'route' | 'nearby'
  selected: [],           // [{id, color, dir}]  dir: 'b' ambos, 'i' ida, 'v' vuelta
  nets: new Set(NETWORKS.map((net) => net.id)), // redes visibles en el mapa y en las rutas
  lineFilter: 'all',      // red que se enseña en la lista de líneas ('all' = todas)
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
// Mapa
// ---------------------------------------------------------------------------

const map = L.map('map', {
  zoomControl: false,
  minZoom: 9,
  maxZoom: 19,
  maxBounds: [[39.4, -5.2], [41.5, -2.4]],
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
    + ' · <a href="https://www.crtm.es" target="_blank" rel="noopener">Powered by CRTM</a>'
    + ' (<a href="https://www.crtm.es/licencia-de-uso/" target="_blank" rel="noopener">licencia</a>)'
    + ' · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">colaboradores de OpenStreetMap</a>',
}).addTo(map);

// Capas, de abajo arriba: borde blanco de las líneas, líneas, enlaces de
// transbordo, paradas y, encima, lo que pintan los modos Ruta y Cerca.
// Solo las paradas y esa última capa reciben clics.
for (const [name, zIndex, interactive] of [
  ['casing', 410, false], ['routes', 420, false], ['links', 430, false], ['stops', 440, true],
  ['journey', 450, true],
]) {
  const pane = map.createPane(name);
  pane.style.zIndex = zIndex;
  if (!interactive) pane.style.pointerEvents = 'none';
}
const casingRenderer = L.svg({ pane: 'casing', padding: 0.5 });
const routeRenderer = L.svg({ pane: 'routes', padding: 0.5 });
const linkRenderer = L.svg({ pane: 'links', padding: 0.5 });
const stopRenderer = L.canvas({ pane: 'stops', padding: 0.3, tolerance: 7 });
// En SVG para que sus huecos dejen pasar los clics a las paradas de debajo.
const journeyRenderer = L.svg({ pane: 'journey', padding: 0.5 });

const casingGroup = L.layerGroup().addTo(map);
const routeGroup = L.layerGroup().addTo(map);
const linkGroup = L.layerGroup().addTo(map);
const stopGroup = L.layerGroup().addTo(map);

const popup = L.popup({ maxWidth: 310, minWidth: 250, autoPanPadding: [16, 16] });
map.on('popupclose', (e) => {
  if (e.popup === popup) state.openStop = null;
});

/** Márgenes para que fitBounds no deje nada debajo del panel. */
function viewPadding() {
  const panel = $('#panel');
  const collapsed = panel.classList.contains('collapsed');
  if (isMobile()) {
    // Con la hoja casi a pantalla completa no queda mapa a la vista: se
    // encuadra como si estuviera a media altura, que es a donde volverá.
    const covered = collapsed ? $('#panel-head').offsetHeight : Math.min(panel.offsetHeight, sheetHeights().half);
    return { paddingTopLeft: [24, 56], paddingBottomRight: [24, covered + 24] };
  }
  const left = collapsed ? 24 : panel.offsetWidth + 36;
  return { paddingTopLeft: [left, 56], paddingBottomRight: [56, 36] };
}

// ---------------------------------------------------------------------------
// Redes y carga de datos
// ---------------------------------------------------------------------------

const netEnabled = (id) => state.nets.has(id);
const enabledNets = () => NETWORKS.filter((net) => state.nets.has(net.id)).map((net) => net.id);

/** Líneas (objetos) de una parada que son de las redes visibles, en el orden de la lista. */
function stopLines(stop) {
  const lines = [];
  for (const id of stop.lines) {
    const line = data.lineById.get(id);
    if (line && state.nets.has(line.net)) lines.push(line);
  }
  return lines.sort((a, b) => a.order - b.order);
}

let visibleCache = { key: null, stops: [] };

/** Paradas con alguna línea de las redes visibles. */
function visibleStops() {
  const key = `${data.stopsVersion}|${enabledNets().join(',')}`;
  if (visibleCache.key !== key) {
    const all = state.nets.size === NETWORKS.length;
    visibleCache = {
      key,
      stops: all ? data.stops : data.stops.filter((stop) => (
        stop.lines.some((id) => state.nets.has(data.lineById.get(id)?.net)))),
    };
  }
  return visibleCache.stops;
}

let knownStopsVersion = 0;

/** Hay que llamarla cuando llegan las paradas de una red: actualiza lo que dependa de ellas. */
function stopsArrived() {
  if (knownStopsVersion === data.stopsVersion) return;
  knownStopsVersion = data.stopsVersion;
  drawStops();
  renderStopResults();
  modes.nearby?.onData();
  // El popup abierto puede ganar líneas de la red recién cargada: se rehace
  // (aquí no hay ningún clic en curso, así que es seguro: ver stopPopupContent).
  if (state.openStop && map.hasLayer(popup)) popup.setContent(stopPopupContent(state.openStop));
}

/** Carga las paradas de una red (una sola vez) y avisa cuando llegan. */
function ensureStops(netId) {
  return loadStops(data, netId).then((stops) => {
    stopsArrived();
    return stops;
  });
}

/** Carga en segundo plano las paradas de las redes visibles que falten. */
function loadMissingStops() {
  for (const id of enabledNets()) {
    ensureStops(id).catch((error) => {
      console.error(error);
      toast(`No se han podido cargar las paradas de ${NET_BY_ID.get(id).name}.`);
    });
  }
}

/**
 * Carga inicial, lo mínimo para poder usar la web: la lista de líneas de las
 * tres redes (ficheros pequeños) y las paradas de la EMT. Las paradas de las
 * otras redes llegan después, en segundo plano, y los recorridos y horarios
 * solo cuando hacen falta.
 */
async function loadBaseData() {
  await Promise.all(NETWORKS.map((net) => loadIndex(data, net.id)));
  data.lines.forEach((line, order) => { line.order = order; });
}

/** Carga (una sola vez) el fichero de una línea y prepara su geometría. */
function loadLine(id) {
  if (!data.lineFiles.has(id)) {
    const line = data.lineById.get(id);
    const promise = Promise.all([fetchJson(lineUrlPath(data, id)), ensureStops(line.net)]).then(([file]) => {
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

/** Activa o desactiva una red en el mapa y en el cálculo de rutas. */
function setNetEnabled(id, on) {
  if (on === state.nets.has(id)) return;
  if (!on && state.nets.size === 1) {
    toast('Tiene que quedar al menos una red visible.');
    return;
  }
  if (on) state.nets.add(id);
  else state.nets.delete(id);
  if (state.lineFilter !== 'all' && !state.nets.has(state.lineFilter)) state.lineFilter = 'all';
  renderNets();
  renderLineFilter();
  renderSelected();
  renderLineList();
  renderStopResults();
  renderSummary();
  updateUrl();
  loadMissingStops();
  if (state.openStop && map.hasLayer(popup)) {
    if (stopLines(state.openStop).length) popup.setContent(stopPopupContent(state.openStop));
    else map.closePopup(popup);
  }
  modes.nearby?.onData();
  modes.route?.onNets();
  syncMap();
}

// ---------------------------------------------------------------------------
// Selección de líneas
// ---------------------------------------------------------------------------

const isSelected = (id) => state.selected.some((s) => s.id === id);
const selectionOf = (id) => state.selected.find((s) => s.id === id);
/** Líneas seleccionadas de las redes visibles: las que se pintan. */
const shownSelection = () => state.selected.filter((s) => state.nets.has(data.lineById.get(s.id).net));

function nextColor() {
  const used = new Set(state.selected.map((s) => s.color));
  return PALETTE.find((c) => !used.has(c)) || PALETTE[state.selected.length % PALETTE.length];
}

function addLines(ids) {
  const added = [];
  for (const id of ids) {
    const line = data.lineById.get(id);
    if (!line || line.nodata || isSelected(id)) continue;
    state.selected.push({ id, color: nextColor(), dir: 'b' });
    added.push(id);
  }
  if (added.length) selectionChanged({ reveal: added });
}

function removeLine(id) {
  removeLines([id]);
}

function removeLines(ids) {
  const gone = new Set(ids);
  state.selected = state.selected.filter((s) => !gone.has(s.id));
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
  renderNets();
  renderSelected();
  renderLineList();
  renderSummary();
  updateUrl();
  modes.nearby?.onSelection();
  // En el modo Ruta no se pintan las líneas: si se añade alguna (desde el
  // popup de una parada), se pasa a Líneas para que se vea.
  if (reveal && state.mode === 'route') setMode('lines');
  await syncMap();
  if (fitAll) fitToLines(state.selected.map((s) => s.id), false);
  else if (reveal) fitToLines(reveal, true);
}

/** Cambios que no alteran la lista (color o sentido de una línea). */
function selectionEdited() {
  renderLineList();
  renderSummary();
  updateUrl();
  modes.nearby?.onSelection();
  syncMap();
}

// ---------------------------------------------------------------------------
// Dibujo en el mapa
// ---------------------------------------------------------------------------

let syncCounter = 0;

/** Carga lo que falte y redibuja líneas, paradas y transbordos. */
async function syncMap() {
  const ticket = ++syncCounter;
  // En el modo Ruta el mapa es para el itinerario: las líneas elegidas se
  // guardan, pero no se pintan hasta volver a Líneas o Cerca.
  const shown = state.mode === 'route' ? [] : shownSelection();
  let files;
  try {
    files = await Promise.all(shown.map((s) => loadLine(s.id)));
  } catch (error) {
    console.error(error);
    toast('No se han podido cargar los datos de alguna línea.');
    return;
  }
  if (ticket !== syncCounter) return; // ya hay una petición más reciente

  const display = [];
  const stopInfo = new Map();
  const lineStops = [];
  shown.forEach((sel, order) => {
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
    // Sin recorrido conocido (paradas unidas en línea recta): trazo discontinuo
    const dashArray = item.dir.src === 'straight' ? `${weight * 1.6} ${weight * 2.2}` : null;
    L.polyline(latlngs, {
      renderer: casingRenderer, pane: 'casing', interactive: false,
      color: '#fff', weight: weight + 2.5, opacity: dashArray ? 0.6 : 0.9, lineJoin: 'round',
    }).addTo(casingGroup);
    L.polyline(latlngs, {
      renderer: routeRenderer, pane: 'routes', interactive: false,
      color: item.sel.color, weight, opacity: 1, lineJoin: 'round', dashArray, lineCap: dashArray ? 'butt' : 'round',
    }).addTo(routeGroup);
  });
}

function addStopMarker(stop, style) {
  L.circleMarker([stop.lat, stop.lon], {
    renderer: stopRenderer, pane: 'stops', bubblingMouseEvents: false,
    fillOpacity: 1, ...style,
  }).on('click', () => openStop(stop)).addTo(stopGroup);
}

/** Color del borde de una parada suelta: el de su red (o neutro si es de varias). */
function stopColor(stop) {
  let net = null;
  for (const line of stopLines(stop)) {
    if (net && net !== line.net) return '#5d7186';
    net = line.net;
  }
  return net ? NET_BY_ID.get(net).soft : '#7c98b6';
}

/** Dibuja las paradas visibles y los puntos de transbordo. */
function drawStops() {
  stopGroup.clearLayers();
  linkGroup.clearLayers();
  const zoom = map.getZoom();
  const bounds = map.getBounds().pad(0.3);
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();
  const inView = (s) => s.lat >= south && s.lat <= north && s.lon >= west && s.lon <= east;
  const base = zoom <= 12 ? 2.5 : zoom === 13 ? 3 : zoom === 14 ? 3.5 : zoom === 15 ? 4.5 : 5.5;
  const showTransfers = state.showTransfers && zoom >= ZOOM.transfers && current.transfers.length > 0;
  const highlighted = (id) => showTransfers && (current.shared.has(id) || current.near.has(id));

  // 1) Resto de paradas de las redes visibles (solo con mucho zoom)
  if (zoom >= ZOOM.allStops) {
    for (const stop of visibleStops()) {
      if (!inView(stop) || current.stopInfo.has(stop.id)) continue;
      addStopMarker(stop, { radius: base - 1, color: stopColor(stop), weight: 1.5, fillColor: '#fff' });
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
// Etiquetas de línea
// ---------------------------------------------------------------------------
//
// La etiqueta de una línea lleva SIEMPRE el color de su red (azul EMT, verde
// interurbanos, rojo urbanos de otros municipios) y, en las urbanas, el
// municipio: «Colmenar Viejo · 1». El color que el usuario ha elegido para
// pintarla en el mapa va aparte, en un punto a la izquierda.

/** Punto con el color elegido por el usuario (hueco si la línea no está pintada). */
function swatch(color) {
  return h('i', { class: `swatch${color ? '' : ' empty'}`, style: color ? `background:${color}` : null, 'aria-hidden': 'true' });
}

/**
 * Etiqueta de una línea.
 * @param {string|null} color  color elegido por el usuario; si se pasa, se añade el punto
 */
function badge(line, color = null) {
  const label = h('span', { class: `badge net-${line.net}${line.nodata ? ' nodata' : ''}`, text: line.label });
  return color ? h('span', { class: 'tag' }, swatch(color), label) : label;
}

/** Etiquetas pequeñas de las líneas de una parada (para listas de paradas). */
function lineMinis(stop, max = 16) {
  const lines = stopLines(stop);
  const out = lines.slice(0, max).map((line) => h('span', { class: `mini net-${line.net}`, text: line.label }));
  if (lines.length > max) out.push(h('span', { class: 'mini more', text: `+${lines.length - max}` }));
  return out;
}

// Recorridos que no vienen en el GTFS (campo `shape` de la línea y `src` de
// cada sentido en su fichero): 'osm' sale de una relación de OpenStreetMap,
// 'routed' de un cálculo de ruta por sus calles y 'straight' une las paradas
// en línea recta (se dibuja discontinuo).
const SHAPE_NOTE = {
  osm: 'Recorrido aproximado, reconstruido con OpenStreetMap',
  routed: 'Recorrido aproximado, calculado por las calles de OpenStreetMap',
  straight: 'Recorrido desconocido: paradas unidas en línea recta',
};
const isApprox = (line) => line.shape === 'osm' || line.shape === 'routed';

/** Aviso de una línea: recorrido aproximado y/o sin horarios (null si no hay nada que avisar). */
function lineNote(line) {
  const parts = [];
  if (line.shape) parts.push(SHAPE_NOTE[line.shape]);
  if (line.nosched) parts.push('sin horarios en el GTFS: no entra en las rutas');
  return parts.length ? parts.join(' · ') : null;
}

const lineTitle = (line) => `${NET_BY_ID.get(line.net).name} · ${line.label} · ${line.long}`
  + (lineNote(line) ? ` · ${lineNote(line)}` : '');

/** Pone un chip de línea al día (seleccionada o no) sin sustituirlo por otro. */
function updateChip(chip, line) {
  const sel = selectionOf(line.id);
  const dot = chip.firstChild;
  chip.classList.toggle('on', Boolean(sel));
  dot.classList.toggle('empty', !sel);
  dot.style.background = sel ? sel.color : '';
  chip.style.setProperty('--c', sel ? sel.color : 'transparent');
  chip.title = lineTitle(line) + (sel ? ' (pulsa para quitarla)' : ' (pulsa para pintarla en el mapa)');
  chip.setAttribute('aria-pressed', sel ? 'true' : 'false');
}

/** Botón para pintar o quitar una línea: su etiqueta con el punto de color delante. */
function lineChip(line) {
  const chip = h('button', { type: 'button', class: 'chip', onclick: () => toggleLine(line.id) },
    swatch(null), badge(line));
  updateChip(chip, line);
  return chip;
}

// ---------------------------------------------------------------------------
// Paradas: popup y buscador
// ---------------------------------------------------------------------------

/**
 * Contenido del popup de una parada. Devuelve el elemento con un método
 * `update()` que lo pone al día (líneas seleccionadas, texto del botón) SIN
 * sustituir sus nodos.
 *
 * Eso es importante: si el contenido se rehace mientras un clic dentro del
 * popup todavía está subiendo por el DOM, el botón pulsado deja de colgar del
 * popup, Leaflet ya no lo reconoce como «clic dentro de un popup» y lo trata
 * como un clic en el mapa, que cierra el popup. Pasaba al quitar una línea o
 * al seleccionar una que ya estaba cargada (si hay que descargarla, el
 * redibujado llega más tarde y no coincide con el clic).
 */
function stopPopupContent(stop) {
  const lines = stopLines(stop);
  const chips = lines.map((line) => [lineChip(line), line]);
  const missing = () => lines.filter((l) => !isSelected(l.id));
  const selectAll = h('button', {
    type: 'button',
    class: 'btn primary',
    onclick: () => addLines(missing().map((l) => l.id)),
  });
  // Agrupadas por red, cada grupo con su nombre
  const groups = [];
  for (const net of NETWORKS) {
    const own = chips.filter(([, line]) => line.net === net.id);
    if (!own.length) continue;
    groups.push(h('div', { class: 'sp-net' },
      h('div', { class: `sp-net-name net-text-${net.id}`, text: net.name }),
      h('div', { class: 'chips' }, own.map(([chip]) => chip))));
  }
  const root = h('div', { class: 'stop-popup' },
    h('div', { class: 'sp-name', text: stop.name }),
    h('div', { class: 'sp-code', text: `Parada nº ${stop.code} · ${lines.length === 1 ? 'pasa 1 línea' : `pasan ${lines.length} líneas`}` }),
    h('div', { class: 'sp-groups' }, groups),
    selectAll,
    h('div', { class: 'sp-route' },
      h('button', { type: 'button', class: 'btn small', onclick: () => routeFromPopup('from', stopPlace(stop)), text: 'Salir de aquí' }),
      h('button', { type: 'button', class: 'btn small', onclick: () => routeFromPopup('to', stopPlace(stop)), text: 'Llegar aquí' }),
    ),
  );
  root.update = () => {
    for (const [chip, line] of chips) updateChip(chip, line);
    const left = missing().length;
    selectAll.disabled = left === 0;
    selectAll.textContent = left === 0
      ? 'Todas pintadas ✓'
      : lines.length === 1 ? 'Pintar esta línea'
        : left === lines.length ? `Pintar las ${lines.length} líneas`
          : left === 1 ? 'Pintar la que falta' : `Pintar las ${left} que faltan`;
  };
  root.update();
  return root;
}

/** Usa un lugar como origen o destino de la ruta (desde un popup del mapa). */
function routeFromPopup(which, place) {
  map.closePopup();
  setMode('route');
  modes.route.setEndpoint(which, place);
}

function openStop(stop) {
  // que el popup no quede debajo del panel
  const padding = viewPadding();
  popup.options.autoPanPaddingTopLeft = L.point(isMobile() ? [12, 56] : [padding.paddingTopLeft[0] - 12, 56]);
  popup.options.autoPanPaddingBottomRight = L.point(isMobile() ? [12, padding.paddingBottomRight[1] - 12] : [56, 28]);
  popup.setLatLng([stop.lat, stop.lon]).setContent(stopPopupContent(stop)).openOn(map);
  state.openStop = stop;
  // Segunda barrera: un clic dentro del popup nunca llega al mapa.
  const el = popup.getElement();
  if (el && !el.dataset.guarded) {
    el.dataset.guarded = '1';
    el.addEventListener('click', (e) => e.stopPropagation());
  }
}

/** Pone al día el popup abierto (sin rehacerlo: ver stopPopupContent). */
function refreshPopup() {
  if (state.openStop && map.hasLayer(popup)) popup.getContent()?.update?.();
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
  const text = $('#stop-search').value;
  list.replaceChildren();
  if (normalizeText(text).length < 2) {
    list.append(h('li', { class: 'empty', text: 'Escribe al menos 2 caracteres: un nombre («Cibeles», «Intercambiador») o el código de la parada.' }));
    return;
  }
  const MAX = 60;
  const { matches, total } = searchStops(visibleStops(), text, MAX);
  if (!matches.length) {
    list.append(h('li', { class: 'empty', text: 'No hay paradas que coincidan.' }));
    return;
  }
  for (const stop of matches) {
    list.append(h('li', {},
      h('button', { type: 'button', class: 'stop-row', onclick: () => focusStop(stop) },
        h('span', { class: 'stop-code', text: stop.code }),
        h('span', { class: 'stop-text' },
          h('span', { class: 'stop-name', text: stop.name }),
          h('span', { class: 'stop-lines' }, lineMinis(stop)),
        ),
      ),
    ));
  }
  if (total > MAX) {
    list.append(h('li', { class: 'empty', text: `Hay ${total - MAX} paradas más: afina la búsqueda.` }));
  }
}

// ---------------------------------------------------------------------------
// Panel: redes visibles (hace también de leyenda de colores)
// ---------------------------------------------------------------------------

function renderNets() {
  const box = $('#nets');
  const row = h('div', { class: 'nets-row' }, h('span', { class: 'nets-title', text: 'Redes' }));
  for (const net of NETWORKS) {
    const on = state.nets.has(net.id);
    row.append(h('button', {
      type: 'button', class: `net-toggle net-${net.id}${on ? ' on' : ''}`, 'aria-pressed': String(on),
      title: `${net.name}: ${on ? 'visible en el mapa y en las rutas (pulsa para ocultarla)' : 'oculta (pulsa para mostrarla)'}`,
      onclick: () => setNetEnabled(net.id, !on),
    }, h('i', { 'aria-hidden': 'true' }), net.short));
  }
  box.replaceChildren(row);
  // Leyenda de los recorridos que no vienen en el GTFS, si hay alguno pintado
  const drawn = shownSelection().map((sel) => data.lineById.get(sel.id));
  const legend = [];
  if (drawn.some(isApprox)) {
    legend.push(h('span', { title: 'Líneas cuyo GTFS no trae recorrido: se ha reconstruido con datos de OpenStreetMap' },
      h('i', { class: 'line-sample', 'aria-hidden': 'true' }), '≈ recorrido aproximado'));
  }
  if (drawn.some((line) => line.shape === 'straight')) {
    legend.push(h('span', { title: 'Sin recorrido conocido: las paradas se unen en línea recta' },
      h('i', { class: 'line-sample dashed', 'aria-hidden': 'true' }), 'en línea recta'));
  }
  if (legend.length) box.append(h('div', { class: 'nets-legend' }, legend));
}

// ---------------------------------------------------------------------------
// Panel: líneas
// ---------------------------------------------------------------------------

function searchLines(text) {
  const query = normalizeText(text);
  const pool = data.lines.filter((line) => (
    state.nets.has(line.net) && (state.lineFilter === 'all' || line.net === state.lineFilter)));
  if (!query) return pool;
  const tokens = query.split(/\s+/);
  const scored = [];
  for (const line of pool) {
    if (!tokens.every((t) => line.search.includes(t))) continue;
    const score = line.nameNorm === query ? 0 : line.nameNorm.startsWith(query) ? 1 : line.nameNorm.includes(query) ? 2 : 3;
    scored.push([score, line]);
  }
  scored.sort((a, b) => a[0] - b[0]); // el orden es estable: a igualdad, orden natural
  return scored.map(([, line]) => line);
}

/** Filtros de la lista de líneas por red. */
function renderLineFilter() {
  const box = $('#line-filter');
  box.replaceChildren();
  const options = [{ id: 'all', short: 'Todas' }, ...NETWORKS.filter((net) => state.nets.has(net.id))];
  if (options.length <= 2) return; // con una sola red visible no hay nada que filtrar
  for (const option of options) {
    const on = state.lineFilter === option.id;
    box.append(h('button', {
      type: 'button', class: `filter${option.id === 'all' ? '' : ` net-${option.id}`}${on ? ' on' : ''}`, 'aria-pressed': String(on),
      onclick: () => {
        state.lineFilter = option.id;
        renderLineFilter();
        renderLineList();
      },
      text: option.short,
    }));
  }
}

function lineRow(line) {
  if (line.nodata) {
    return h('li', {},
      h('div', { class: 'line-row disabled', title: 'El GTFS publicado por el CRTM no trae el recorrido ni los horarios de esta línea' },
        badge(line),
        h('span', { class: 'line-long', text: line.long }),
        h('span', { class: 'no-data', text: 'sin datos' }),
      ));
  }
  const sel = selectionOf(line.id);
  return h('li', {},
    h('button', {
      type: 'button',
      class: 'line-row' + (sel ? ' on' : ''),
      'aria-pressed': sel ? 'true' : 'false',
      title: lineTitle(line),
      onclick: () => toggleLine(line.id),
    },
    badge(line, sel?.color),
    h('span', { class: 'line-long', text: line.long }),
    line.shape ? h('span', { class: `approx${line.shape === 'straight' ? ' straight' : ''}`, text: line.shape === 'straight' ? 'recto' : '≈ aprox.' }) : null,
    h('span', { class: 'check', 'aria-hidden': 'true', text: sel ? '✓' : '+' }),
    ),
  );
}

function renderLineList() {
  const list = $('#line-list');
  const query = $('#line-search').value;
  const lines = searchLines(query);
  $('#line-list-title').textContent = query.trim()
    ? `Resultados (${lines.length})`
    : state.lineFilter === 'all' ? `Todas las líneas (${lines.length})` : `Líneas (${lines.length})`;
  list.replaceChildren();
  if (!lines.length) {
    list.append(h('li', { class: 'empty', text: 'No hay líneas que coincidan. Puedes buscar por número, por nombre o por municipio («Alcalá», «Móstoles»).' }));
    return;
  }
  // Agrupadas por red; dentro de cada red, en el orden de la búsqueda
  for (const net of NETWORKS) {
    const own = lines.filter((line) => line.net === net.id);
    if (!own.length) continue;
    list.append(h('li', { class: `net-head net-text-${net.id}` },
      h('i', { class: `net-dot net-${net.id}`, 'aria-hidden': 'true' }),
      h('span', { text: net.name }),
      h('small', { text: String(own.length) })));
    for (const line of own) list.append(lineRow(line));
  }
}

function directionSelect(sel, line) {
  const select = h('select', {
    class: 'dir-select',
    'aria-label': `Sentido de la línea ${line.label}`,
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
    const examples = EXAMPLE_LINES.map((id) => data.lineById.get(id)).filter(Boolean);
    box.append(h('div', { class: 'hint' },
      h('p', { text: 'Elige líneas en la lista para verlas en el mapa. Con dos o más verás dónde se cruzan para hacer transbordo.' }),
      examples.length ? h('button', {
        type: 'button', class: 'btn',
        onclick: () => addLines(examples.map((line) => line.id)),
        text: `Probar con ${examples.map((line) => line.name).join(', ')}`,
      }) : null,
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
    const hidden = !state.nets.has(line.net);
    const color = h('input', {
      type: 'color', class: 'color', value: sel.color,
      title: 'Color con el que se pinta en el mapa (pulsa para cambiarlo)', 'aria-label': `Color de la línea ${line.label}`,
      oninput: (e) => {
        sel.color = e.target.value.toLowerCase();
        selectionEditedSoon();
      },
    });
    list.append(h('li', { class: `selected-row${hidden ? ' off' : ''}` },
      color,
      h('div', { class: 'selected-main' },
        h('div', { class: 'selected-name' }, badge(line), h('span', { class: 'line-long', title: line.long, text: line.long })),
        hidden
          ? h('div', { class: 'selected-note', text: `Red oculta: actívala en «Redes» para verla.` })
          : directionSelect(sel, line),
        !hidden && lineNote(line) ? h('div', { class: 'selected-note approx-note' },
          h('i', { class: `line-sample${line.shape === 'straight' ? ' dashed' : ''}`, style: `color:${sel.color}`, 'aria-hidden': 'true' }),
          lineNote(line)) : null,
      ),
      h('button', {
        type: 'button', class: 'icon', title: 'Centrar el mapa en la línea',
        'aria-label': `Centrar el mapa en la línea ${line.label}`, disabled: hidden,
        onclick: () => {
          if (isMobile()) setPanelCollapsed(true);
          fitToLines([sel.id], false);
        },
      }, h('span', { class: 'ico-target', 'aria-hidden': 'true' })),
      h('button', {
        type: 'button', class: 'icon', title: 'Quitar línea', 'aria-label': `Quitar la línea ${line.label}`,
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
  if (state.mode === 'lines') {
    for (const sel of shownSelection()) box.append(badge(data.lineById.get(sel.id), sel.color));
  } else {
    box.append(...modes[state.mode].summary());
  }
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
  const shown = shownSelection();
  const total = current.shared.size + current.links.length;
  counter.hidden = shown.length < 2;
  counter.textContent = total;

  if (shown.length < 2) {
    box.append(h('p', { class: 'empty', text: 'Selecciona dos o más líneas (de la misma red o de redes distintas) para ver dónde puedes hacer transbordo entre ellas.' }));
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
// Panel: pestañas y modos
// ---------------------------------------------------------------------------

function showTab(name) {
  for (const button of document.querySelectorAll('.tabs [data-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === name));
  }
  for (const section of document.querySelectorAll('.tab')) {
    section.hidden = section.id !== `tab-${name}`;
  }
}

/** Cambia entre los modos Líneas, Ruta y Cerca. Cada uno pinta lo suyo en el mapa. */
function setMode(mode) {
  if (!modes[mode] && mode !== 'lines') return;
  const previous = state.mode;
  state.mode = mode;
  for (const button of document.querySelectorAll('.modes [data-mode]')) {
    button.setAttribute('aria-selected', String(button.dataset.mode === mode));
  }
  for (const section of document.querySelectorAll('.mode')) {
    section.hidden = section.id !== `mode-${mode}`;
  }
  if (previous === mode) return;
  modes[previous]?.deactivate();
  modes[mode]?.activate();
  renderSummary();
  updateUrl();
  syncMap();
}

function setupPanel() {
  setupSheet();
  for (const button of document.querySelectorAll('.modes [data-mode]')) {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  }
  for (const button of document.querySelectorAll('.tabs [data-tab]')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }
  // En móvil, al escribir en un buscador la hoja ocupa toda la pantalla para
  // que el teclado no tape los resultados.
  const panel = $('#panel');
  panel.addEventListener('focusin', (e) => {
    if (e.target.matches('input[type="search"]')) panel.classList.add('typing');
  });
  panel.addEventListener('focusout', () => panel.classList.remove('typing'));
  $('#line-search').addEventListener('input', renderLineList);
  $('#line-search').addEventListener('keydown', (e) => {
    // Enter selecciona el primer resultado
    if (e.key !== 'Enter' || !e.target.value.trim()) return;
    const first = searchLines(e.target.value).find((line) => !line.nodata);
    if (first && !isSelected(first.id)) addLines([first.id]);
  });
  $('#stop-search').addEventListener('input', debounce(renderStopResults, 120));
  // Un toque en el mapa: en Ruta y Cerca elige un punto; en móvil, además,
  // se pliega el panel para ver mejor.
  map.on('click', (e) => {
    const handled = modes[state.mode]?.onMapClick(e.latlng);
    if (isMobile() && !handled) setPanelCollapsed(true);
  });
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

let lastHash = null;
const MODE_TO_URL = { route: 'ruta', nearby: 'cerca' };
const URL_TO_MODE = { ruta: 'route', cerca: 'nearby' };

const updateUrl = debounce(() => {
  const center = map.getCenter();
  const params = { ...modes.route?.urlParams(), ...modes.nearby?.urlParams() };
  if (state.mode !== 'lines') params.t = MODE_TO_URL[state.mode];
  if (state.nets.size < NETWORKS.length) params.n = enabledNets().join(',');
  const hash = buildHash(
    state.selected.map((s) => ({ name: lineToUrl(s.id), color: s.color, dir: s.dir })),
    { zoom: map.getZoom(), lat: center.lat, lng: center.lng },
    params,
  );
  lastHash = hash;
  history.replaceState(null, '', hash || location.pathname + location.search);
}, 250);

/** Aplica el estado de la URL. Devuelve true si la URL traía una vista de mapa. */
function applyHash() {
  const parsed = parseHash(location.hash);
  // n = redes visibles (si falta, todas)
  const wanted = (parsed.params.n || '').split(',').filter((id) => NET_BY_ID.has(id));
  state.nets = new Set(wanted.length ? wanted : NETWORKS.map((net) => net.id));
  if (state.lineFilter !== 'all' && !state.nets.has(state.lineFilter)) state.lineFilter = 'all';
  state.selected = [];
  for (const item of parsed.lines) {
    // «27» es la 27 de la EMT (como en los enlaces de la v0.2); «inter.625», la interurbana 625
    const line = data.lineByUrl.get(item.name.toUpperCase());
    if (!line || line.nodata || isSelected(line.id)) continue;
    state.selected.push({ id: line.id, color: item.color || nextColor(), dir: item.dir });
  }
  if (parsed.view) map.setView([parsed.view.lat, parsed.view.lng], parsed.view.zoom, { animate: false });
  renderNets();
  renderLineFilter();
  modes.route.applyParams(parsed.params, Boolean(parsed.view));
  modes.nearby.applyParams(parsed.params, Boolean(parsed.view));
  setMode(URL_TO_MODE[parsed.params.t] || 'lines');
  return Boolean(parsed.view);
}

window.addEventListener('hashchange', () => {
  if (location.hash === lastHash) return; // el cambio lo hemos hecho nosotros
  const hadView = applyHash();
  loadMissingStops();
  renderStopResults();
  selectionChanged({ fitAll: !hadView });
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

/** Los modos Ruta y Cerca viven en sus módulos; esto es lo que comparten con este. */
const modes = {};

function setupModes() {
  const context = {
    map, data, state,
    renderers: { casing: casingRenderer, routes: routeRenderer, journey: journeyRenderer },
    loadLine, selectionOf, isSelected, toggleLine, addLines, removeLines,
    lineChip, badge, lineMinis, stopLines, visibleStops, enabledNets, ensureStops,
    openStop, focusStop, viewPadding, setPanelCollapsed, setSheet, setMode,
    updateUrl, renderSummary,
    routeFromPopup,
  };
  modes.route = initPlanner(context);
  modes.nearby = initNearby(context);
}

function showFeedDates() {
  const format = (iso) => {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  };
  const emt = data.nets.get('emt')?.feed?.date;
  const crtm = data.nets.get('inter')?.feed?.date || data.nets.get('urb')?.feed?.date;
  if (emt) $('#feed-date-emt').textContent = ` (actualizado el ${format(emt)})`;
  if (crtm) $('#feed-date-crtm').textContent = ` (actualizados el ${format(crtm)})`;
}

async function main() {
  setupPanel();
  try {
    await loadBaseData();
  } catch (error) {
    console.error(error);
    $('#selected-box').append(h('p', { class: 'empty', text: 'No se han podido cargar los datos. Si has abierto el fichero directamente, usa un servidor local (mira el README).' }));
    return;
  }
  showFeedDates();
  setupModes();
  const hadView = applyHash();
  if (isMobile() && state.selected.length && state.mode === 'lines') setPanelCollapsed(true);
  renderStopResults();
  // Las paradas no bloquean el arranque: llegan en segundo plano, red a red.
  loadMissingStops();
  await selectionChanged({ fitAll: !hadView && state.selected.length > 0 });
}

main();
