// Datos de las redes: identificadores de línea, carga por partes y unión de
// las paradas de varias redes. No toca el DOM (lo usa también la prueba de
// Node, tests/router.test.mjs).
//
// IDENTIFICADORES. Cada línea tiene un id único entre todas las redes:
//
//     emt:27                  línea 27 de la EMT
//     inter:625               interurbana 625
//     urb-colmenar-viejo:1    línea 1 urbana de Colmenar Viejo
//
// Así la «1» de la EMT, la «1» de Móstoles y la «1» de Las Rozas no se mezclan
// nunca. La parte anterior a los dos puntos empieza siempre por el id de la red.
//
// CARGA POR PARTES. De cada red (data/<red>/) se cargan por separado:
//
//     index.json           lista de líneas: al arrancar (es pequeño)
//     stops.json           paradas: al arrancar la EMT; el resto, en segundo plano
//     lines/<línea>.json   recorrido de una línea: al seleccionarla
//     routing.json         horarios: al abrir el modo Ruta
//
// PARADAS. Las dos redes del CRTM comparten paradas (el mismo poste sirve a
// interurbanos y a urbanos): se unen por su id y cada parada lleva las líneas
// de todas las redes cargadas que pasan por ella.

import { NETWORKS } from './config.js';
import { normalizeText } from './geo.js';

/** 'urb-colmenar-viejo:1' -> 'urb' */
export function netOfLine(id) {
  const prefix = id.slice(0, id.indexOf(':'));
  const dash = prefix.indexOf('-');
  return dash < 0 ? prefix : prefix.slice(0, dash);
}

/** Nombre del fichero de una línea (igual que file_key en scripts/build_data.py). */
export function lineFile(id) {
  const colon = id.indexOf(':');
  const prefix = id.slice(0, colon);
  const name = id.slice(colon + 1).replace(/[^A-Za-z0-9_-]/g, '-');
  return prefix.startsWith('urb-') ? `${prefix.slice(4)}_${name}` : name;
}

/**
 * Línea en la URL: las de la EMT van solo con su nombre (como en la v0.2:
 * «27», «C1») y las demás cambian los dos puntos por un punto («inter.625»).
 */
export const lineToUrl = (id) => (id.startsWith('emt:') ? id.slice(4) : id.replace(':', '.'));

export function createStore() {
  return {
    nets: new Map(),        // id de red -> {def, feed, lines, stops, promesas de carga}
    lines: [],              // todas las líneas, red a red y en su orden natural
    lineById: new Map(),
    lineByUrl: new Map(),   // texto de la URL en mayúsculas -> línea
    stops: [],              // todas las paradas, sin repetir
    stopById: new Map(),
    stopsByCode: new Map(), // código -> paradas con ese código (para unir postes compartidos)
    stopsVersion: 0,        // cambia cada vez que se cargan paradas de otra red
  };
}

const netState = (store, id) => {
  if (!store.nets.has(id)) {
    store.nets.set(id, { def: NETWORKS.find((n) => n.id === id), feed: null, lines: [], stops: null, loading: {} });
  }
  return store.nets.get(id);
};

/** Registra las líneas de una red a partir de su index.json. */
export function addIndex(store, netId, index) {
  const net = netState(store, netId);
  net.feed = index.feed;
  net.lines = index.lines.map((raw) => {
    const label = raw.muni ? `${raw.muni} · ${raw.name}` : raw.name;
    return {
      ...raw,
      net: netId,
      muni: raw.muni || null,
      nodata: Boolean(raw.nodata),
      label,
      nameNorm: normalizeText(raw.name),
      search: normalizeText([raw.name, raw.muni || '', raw.long, ...raw.dirs.map((d) => d.headsign), net.def.name, net.def.short].join(' ')),
    };
  });
  for (const line of net.lines) {
    store.lineById.set(line.id, line);
    store.lineByUrl.set(lineToUrl(line.id).toUpperCase(), line);
  }
  // Se reconstruye la lista completa respetando el orden de NETWORKS
  store.lines = NETWORKS.flatMap((def) => store.nets.get(def.id)?.lines || []);
  return net.lines;
}

// Los interurbanos que entran en Madrid paran en postes de la EMT, y el GTFS
// del CRTM los trae con el mismo código de parada que el de la EMT. Si además
// están en el mismo sitio (a menos de 40 m) son la misma parada.
const SAME_STOP_M = 40;
const KX = 111320 * Math.cos((40.42 * Math.PI) / 180);
const KY = 110540;
const netRank = (id) => NETWORKS.findIndex((n) => n.id === id);

/**
 * Añade las paradas de una red (su stops.json) uniéndolas con las que ya
 * hubiera: por id (las dos redes del CRTM comparten paradas) o por código y
 * posición (postes de la EMT donde también paran interurbanos). Devuelve la
 * lista en el orden del fichero, que es el que usan los horarios
 * (routing.json) para referirse a ellas.
 */
export function addStops(store, netId, file) {
  const net = netState(store, netId);
  net.stops = file.stops.map(([id, code, name, lat, lon, lineIndexes]) => {
    const lines = lineIndexes.map((i) => net.lines[i].id);
    let stop = store.stopById.get(id);
    if (!stop) {
      stop = (store.stopsByCode.get(code) || []).find((other) => (
        other.net !== netId
        && Math.hypot((other.lon - lon) * KX, (other.lat - lat) * KY) <= SAME_STOP_M));
      if (stop) store.stopById.set(id, stop);
    }
    if (stop) {
      for (const line of lines) if (!stop.lines.includes(line)) stop.lines.push(line);
      // Manda el nombre de la red que va antes en NETWORKS (la EMT en Madrid)
      if (netRank(netId) < netRank(stop.net)) {
        Object.assign(stop, { net: netId, name, lat, lon, nameNorm: normalizeText(name), search: normalizeText(`${code} ${name}`) });
      }
    } else {
      stop = {
        id, code, name, lat, lon, lines,
        net: netId,   // red de la que salen su nombre y su posición
        nameNorm: normalizeText(name),
        search: normalizeText(`${code} ${name}`),
      };
      store.stopById.set(id, stop);
      store.stops.push(stop);
      if (!store.stopsByCode.has(code)) store.stopsByCode.set(code, []);
      store.stopsByCode.get(code).push(stop);
    }
    return stop;
  });
  store.stopsVersion++;
  return net.stops;
}

// ---------------------------------------------------------------------------
// Carga desde el servidor (solo en el navegador)
// ---------------------------------------------------------------------------

export async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

/** Lanza una carga una sola vez; si falla, se podrá reintentar. */
function once(net, key, start) {
  if (!net.loading[key]) {
    net.loading[key] = start();
    net.loading[key].catch(() => { delete net.loading[key]; });
  }
  return net.loading[key];
}

export function loadIndex(store, netId) {
  const net = netState(store, netId);
  return once(net, 'index', async () => addIndex(store, netId, await fetchJson(`${net.def.path}/index.json`)));
}

export function loadStops(store, netId) {
  const net = netState(store, netId);
  return once(net, 'stops', async () => {
    const [, file] = await Promise.all([loadIndex(store, netId), fetchJson(`${net.def.path}/stops.json`)]);
    return addStops(store, netId, file);
  });
}

/** Horarios de una red, listos para buildGraph (js/router.js). */
export function loadRouting(store, netId) {
  const net = netState(store, netId);
  return once(net, 'routing', async () => {
    const [stops, routing] = await Promise.all([loadStops(store, netId), fetchJson(`${net.def.path}/routing.json`)]);
    return { id: netId, stops, lines: net.lines, routing };
  });
}

export const lineUrlPath = (store, id) => `${store.nets.get(netOfLine(id)).def.path}/lines/${lineFile(id)}.json`;
