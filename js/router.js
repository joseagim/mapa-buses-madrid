// Buscador de rutas en autobús. No toca el DOM: se puede probar con Node
// (tests/router.test.mjs).
//
// DATOS. Cada red aporta sus paradas, sus líneas y su routing.json, con un
// «recorrido» por línea, sentido y secuencia de paradas: lista de paradas,
// perfil de tiempos y, por cada conjunto de fechas, «franjas» [primera salida,
// última salida, nº de salidas, duración]. Hay dos tipos de red:
//
//   - De FRECUENCIA (EMT, `exact: false`): dentro de una franja las salidas se
//     suponen repartidas de forma regular. Si pasan cada 15 min o menos, se
//     espera de media medio intervalo (un autobús urbano no cumple un horario
//     al minuto); si pasan cada más de 15 min, se espera a la siguiente salida.
//   - De HORARIO (interurbanos y urbanos del CRTM, `exact: true`): las franjas
//     guardan las salidas reales (primera + k × intervalo, sin pérdida) y
//     siempre se espera a la siguiente salida. Son líneas de poca frecuencia:
//     suponer «medio intervalo» daría errores de media hora.
//
// CALENDARIO. Cada conjunto de fechas es una ristra de bits, uno por día desde
// `calendar.start`. Fuera de esa ventana se usa el día de la semana. Los
// festivos que conoce una red valen para las demás cuando su GTFS no detalla
// esa fecha: ese día se aplica el horario del domingo siguiente.
//
// ALGORITMO. RAPTOR: en la ronda k se calcula la hora más temprana de llegada
// a cada parada usando como mucho k autobuses. En cada ronda se recorren solo
// los recorridos que pasan por paradas mejoradas en la ronda anterior y luego
// se propagan los transbordos a pie. Es tan rápido (milisegundos) que para
// sacar alternativas se lanza varias veces vetando las líneas ya usadas.
//
// VARIAS REDES. El grafo se monta con todas las redes que se le pasen: los
// recorridos se concatenan y los transbordos a pie salen de las coordenadas,
// así que los transbordos entre redes (de un interurbano a la EMT en un
// intercambiador) no necesitan nada especial.

import { ROUTING } from './config.js';
import { PointGrid, distanceM } from './geo.js';

const DAY = 86400;
const SUPPORTED_VERSION = 2;

// ---------------------------------------------------------------------------
// Grafo
// ---------------------------------------------------------------------------

/**
 * @param {Array<{id:string, stops:Array, lines:Array, routing:object}>} networks
 *        `stops` y `lines` en el mismo orden que stops.json e index.json; cada
 *        parada {lat, lon, ...} y cada línea {id, ...}. Una misma parada puede
 *        venir en varias redes (el mismo objeto): entra una sola vez.
 */
export function buildGraph(networks, options = {}) {
  const opt = { ...ROUTING, ...options };
  const stops = [];
  const stopIndex = new Map(); // objeto parada -> posición en `stops`
  const patterns = [];
  const calendars = [];
  const holidays = new Set();
  const lineKeys = new Map(); // id de línea -> [índices de recorrido]

  for (const net of networks) {
    const routing = net.routing;
    if (routing.version !== SUPPORTED_VERSION) {
      throw new Error(`routing.json de ${net.id}: versión ${routing.version} no soportada`);
    }
    const local = net.stops.map((stop) => {
      if (!stopIndex.has(stop)) {
        stopIndex.set(stop, stops.length);
        stops.push(stop);
      }
      return stopIndex.get(stop);
    });
    const cal = calendars.length;
    calendars.push({ net: net.id, ...routing.calendar });
    for (const date of routing.calendar.holidays) holidays.add(date);
    for (const raw of routing.patterns) {
      const total = raw.time[raw.time.length - 1];
      const key = net.lines[raw.line].id;
      const index = patterns.length;
      patterns.push({
        index,
        net: net.id,
        line: key,
        lineKey: key,
        dir: raw.dir,
        cal,
        exact: Boolean(routing.exact),
        estimated: Boolean(raw.est), // el GTFS no trae horas de paso: tiempos de recorrido estimados
        stops: Int32Array.from(raw.stops, (s) => local[s]),
        frac: Float64Array.from(raw.time, (t) => t / total), // 0 en la cabecera, 1 al final
        bandsBySet: raw.bands,   // [[conjunto de fechas, franjas], ...]
        bands: null,             // franjas del día consultado (prepareDay)
        schedHeadway: routing.scheduleHeadway,
      });
      if (!lineKeys.has(key)) lineKeys.set(key, []);
      lineKeys.get(key).push(index);
    }
  }

  // parada -> [recorrido, posición, recorrido, posición, ...]
  const stopPats = stops.map(() => []);
  for (const pat of patterns) {
    pat.stops.forEach((s, pos) => stopPats[s].push(pat.index, pos));
  }

  // Transbordos a pie: parada -> [otra parada, segundos, ...]
  const grid = new PointGrid(stops, 300);
  const walkSecPerM = (opt.walkDetour * 3.6) / opt.walkSpeedKmh;
  const foot = stops.map((stop, i) => {
    const list = [];
    for (const hit of grid.within(stop.lat, stop.lon, opt.transferMaxM)) {
      if (hit.index !== i) list.push(hit.index, hit.dist * walkSecPerM);
    }
    return list;
  });

  return { opt, stops, patterns, calendars, holidays, lineKeys, stopPats, foot, grid, walkSecPerM, day: null };
}

// ---------------------------------------------------------------------------
// Calendario
// ---------------------------------------------------------------------------

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const dayNumber = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);

/**
 * Conjuntos de fechas de una red que están en vigor un día 'AAAA-MM-DD'.
 * Devuelve {active: Uint8Array (1 = en vigor), stale: true si la fecha queda
 * fuera de la ventana de los datos}.
 *
 * @param {Set<string>} holidays  festivos conocidos por cualquiera de las redes
 */
export function activeSets(calendar, iso, holidays = new Set()) {
  let weekday = (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = lunes
  let date = iso;
  // Festivo que el GTFS de esta red no detalla: se aplica el horario del
  // domingo siguiente (el del mismo día si ya es domingo).
  if (holidays.has(iso) && iso > calendar.detailTo && weekday !== 6) {
    date = addDays(iso, 6 - weekday);
    weekday = 6;
  }
  const index = dayNumber(date) - dayNumber(calendar.start);
  const stale = index < 0 || index >= calendar.days;
  const active = new Uint8Array(calendar.sets.length);
  for (let i = 0; i < active.length; i++) {
    active[i] = stale
      // Fecha fuera de la ventana (datos caducados o fecha lejana): se usa el
      // día de la semana, que es mejor que no dar ninguna ruta.
      ? (calendar.week[i] >> weekday) & 1
      : (parseInt(calendar.sets[i][index >> 2], 16) >> (index & 3)) & 1;
  }
  return { active, stale };
}

/**
 * Prepara las franjas de cada recorrido para una fecha: las del día, las del
 * día anterior (los búhos salen pasadas las 24:00 de su día de servicio) y las
 * del siguiente (por si el viaje cruza la medianoche). Tiempos en segundos
 * desde las 0:00 de `iso`.
 */
function prepareDay(graph, iso) {
  if (graph.day?.date === iso) return graph.day;
  let stale = false;
  const perCal = graph.calendars.map((cal) => [-1, 0, 1].map((offset) => {
    const result = activeSets(cal, addDays(iso, offset), graph.holidays);
    if (offset === 0 && result.stale) stale = true;
    return { offset, active: result.active };
  }));
  for (const pat of graph.patterns) {
    const quads = [];
    for (const { offset, active } of perCal[pat.cal]) {
      for (const [set, bands] of pat.bandsBySet) {
        if (!active[set]) continue;
        for (let b = 0; b < bands.length; b += 4) {
          quads.push([bands[b] + offset * DAY, bands[b + 1] + offset * DAY, bands[b + 2], bands[b + 3]]);
        }
      }
    }
    quads.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    pat.bands = Float64Array.from(quads.flat());
  }
  graph.day = { date: iso, stale };
  return graph.day;
}

// ---------------------------------------------------------------------------
// Subir a un autobús
// ---------------------------------------------------------------------------

// Resultado de board() (variables de módulo para no crear objetos en el bucle).
let bDepart = 0;   // hora a la que se sale de la parada
let bDur = 0;      // duración del recorrido completo en esa franja
let bGap = 0;      // intervalo entre autobuses (0 = salida única)
let bFreq = false; // true: se ha esperado «medio intervalo»; false: salida concreta

/**
 * Primera salida que se puede coger en la posición `frac` (0..1) del recorrido
 * estando en la parada a la hora `t`. Devuelve false si ya no pasa ninguno.
 */
function board(pat, frac, t) {
  const bands = pat.bands;
  let found = false;
  for (let b = 0; b < bands.length; b += 4) {
    const dur = bands[b + 3];
    const shift = frac * dur; // lo que tarda el bus desde la cabecera hasta aquí
    const first = bands[b] + shift;
    const last = bands[b + 1] + shift;
    if (t > last) continue;
    if (found && bands[b] >= bDepart) break; // las franjas van ordenadas por su primera salida
    const n = bands[b + 2];
    const gap = n > 1 ? (last - first) / (n - 1) : 0;
    let depart;
    let freq = false;
    if (t <= first) {
      depart = first;
      // hueco entre dos franjas de una línea frecuente: sigue siendo «cada X min»
      freq = !pat.exact && gap > 0 && gap <= pat.schedHeadway && first - t <= gap;
    } else if (!pat.exact && gap <= pat.schedHeadway) {
      depart = Math.min(t + gap / 2, last);
      freq = true;
    } else {
      // horario: la siguiente salida de la franja (primera + k × intervalo)
      depart = first + Math.ceil((t - first) / gap - 1e-9) * gap;
    }
    if (!found || depart < bDepart) {
      found = true;
      bDepart = depart;
      bDur = dur;
      bGap = gap;
      bFreq = freq;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// RAPTOR
// ---------------------------------------------------------------------------

/**
 * @param {object} q  {t0, access: Map(parada -> s a pie), egress: Map(parada -> s a pie)}
 * @param {Uint8Array} banned  recorridos vetados (1 = no usar)
 * @returns {Array} un viaje por ronda que mejora la llegada (frente de Pareto
 *          llegada / nº de autobuses), cada uno como lista de tramos en bruto.
 */
function raptor(graph, q, banned) {
  const { stops, patterns, stopPats, foot, opt } = graph;
  const n = stops.length;
  const K = opt.maxRides;
  const reluct = opt.walkReluctance;

  const best = new Float64Array(n).fill(Infinity);
  const tau = [];      // tau[k][s]: llegada a s en la ronda k (en bus o andando desde otra parada)
  const rideArr = [];  // rideArr[k][s]: llegada a s bajando de un bus en la ronda k
  const rPat = [];
  const rBoard = [];
  const rAlight = [];
  const wFrom = [];    // wFrom[k][s]: parada desde la que se llegó andando (-1 = no)
  for (let k = 0; k <= K; k++) {
    tau.push(new Float64Array(n).fill(Infinity));
    rideArr.push(new Float64Array(n).fill(Infinity));
    rPat.push(new Int32Array(n).fill(-1));
    rBoard.push(new Int32Array(n));
    rAlight.push(new Int32Array(n));
    wFrom.push(new Int32Array(n).fill(-1));
  }
  const egress = new Float64Array(n).fill(Infinity);
  for (const [s, sec] of q.egress) egress[s] = sec * reluct;

  let marked = [];
  for (const [s, sec] of q.access) {
    tau[0][s] = best[s] = q.t0 + sec * reluct;
    marked.push(s);
  }

  let bestTarget = Infinity;
  const journeys = [];
  const queue = new Int32Array(patterns.length); // posición más temprana a revisar
  const queued = [];

  for (let k = 1; k <= K && marked.length; k++) {
    // Recorridos que pasan por las paradas mejoradas en la ronda anterior
    queued.length = 0;
    for (const s of marked) {
      const list = stopPats[s];
      for (let i = 0; i < list.length; i += 2) {
        const p = list[i];
        if (banned[p]) continue;
        const pos = list[i + 1];
        if (queue[p] === 0) {
          queue[p] = pos + 1;
          queued.push(p);
        } else if (pos + 1 < queue[p]) {
          queue[p] = pos + 1;
        }
      }
    }

    const prev = tau[k - 1];
    const slack = k > 1 ? opt.transferSlackS : 0;
    const improved = [];
    let roundTarget = Infinity;
    let roundStop = -1;

    for (const p of queued) {
      const pat = patterns[p];
      const st = pat.stops;
      const frac = pat.frac;
      const last = st.length - 1;
      let onBoard = false;
      let dep = 0;
      let bpos = 0;
      let dur = 0;
      for (let pos = queue[p] - 1; pos <= last; pos++) {
        const s = st[pos];
        let arr = Infinity;
        if (onBoard) {
          arr = dep + (frac[pos] - frac[bpos]) * dur;
          if (arr < best[s] && arr < bestTarget) {
            if (rideArr[k][s] === Infinity) improved.push(s);
            rideArr[k][s] = tau[k][s] = best[s] = arr;
            rPat[k][s] = p;
            rBoard[k][s] = bpos;
            rAlight[k][s] = pos;
            wFrom[k][s] = -1;
            if (arr + egress[s] < roundTarget) {
              roundTarget = arr + egress[s];
              roundStop = s;
            }
          }
        }
        // ¿Se puede subir aquí (o coger un autobús anterior al que llevamos)?
        if (pos < last && prev[s] < arr && board(pat, frac[pos], prev[s] + slack) && bDepart < arr) {
          onBoard = true;
          dep = bDepart;
          bpos = pos;
          dur = bDur;
        }
      }
      queue[p] = 0;
    }

    if (roundTarget < bestTarget) {
      bestTarget = roundTarget;
      journeys.push(reconstruct(k, roundStop));
    }

    // Transbordos a pie desde las paradas a las que se ha llegado en bus
    marked = improved.slice();
    for (const s of improved) {
      const from = rideArr[k][s];
      const list = foot[s];
      for (let i = 0; i < list.length; i += 2) {
        const s2 = list[i];
        const t2 = from + list[i + 1] * reluct;
        if (t2 < best[s2] && t2 < bestTarget) {
          if (tau[k][s2] === Infinity) marked.push(s2);
          tau[k][s2] = best[s2] = t2;
          wFrom[k][s2] = s;
        }
      }
    }
  }
  return journeys;

  function reconstruct(k, target) {
    const rides = [];
    let s = target;
    for (let r = k; r >= 1; r--) {
      const pat = patterns[rPat[r][s]];
      rides.unshift({ pattern: pat, boardPos: rBoard[r][s], alightPos: rAlight[r][s] });
      s = pat.stops[rBoard[r][s]];
      if (wFrom[r - 1][s] >= 0) s = wFrom[r - 1][s];
    }
    return rides;
  }
}

// ---------------------------------------------------------------------------
// De la lista de autobuses al itinerario con horas
// ---------------------------------------------------------------------------

/** Otros recorridos (de otras líneas) que llevan de la misma parada a la misma parada. */
function alternativesFor(graph, ride) {
  const { pattern, boardPos, alightPos } = ride;
  const from = pattern.stops[boardPos];
  const to = pattern.stops[alightPos];
  const list = graph.stopPats[from];
  const seen = new Set([pattern.lineKey]);
  const out = [];
  for (let i = 0; i < list.length; i += 2) {
    const other = graph.patterns[list[i]];
    if (seen.has(other.lineKey)) continue;
    const pos = list[i + 1];
    const end = other.stops.indexOf(to, pos + 1);
    if (end < 0) continue;
    seen.add(other.lineKey);
    out.push({ pattern: other, boardPos: pos, alightPos: end });
  }
  return out;
}

/**
 * Recorre un viaje (lista de autobuses) desde la hora de salida y calcula los
 * tramos con sus horas reales (sin el recargo por andar que usa la búsqueda).
 * Si varias líneas hacen el mismo tramo parada a parada, se juntan: se coge
 * la primera que pase, así que la espera es menor.
 */
function buildItinerary(graph, q, rides) {
  const { stops, opt, walkSecPerM } = graph;
  const legs = [];
  let t = q.t0;
  let here = q.from; // {lat, lon, name}
  let walkTime = 0;
  let walkDist = 0;
  let waitTime = 0;

  const walkTo = (place, kind) => {
    const straight = distanceM(here.lat, here.lon, place.lat, place.lon);
    const time = straight * walkSecPerM;
    if (straight >= 20) {
      legs.push({
        type: 'walk', kind, from: here, to: place,
        dist: straight * opt.walkDetour, time, start: t, end: t + time,
      });
      walkDist += straight * opt.walkDetour;
    }
    walkTime += time;
    t += time;
    here = place;
  };

  rides.forEach((ride, index) => {
    const boardStop = stops[ride.pattern.stops[ride.boardPos]];
    const alightStop = stops[ride.pattern.stops[ride.alightPos]];
    walkTo(boardStop, index === 0 ? 'access' : 'transfer');

    // Todas las líneas que hacen este tramo parada a parada. La «principal» es
    // la que antes llega; las demás cuentan si no llegan mucho más tarde.
    const ready = t + (index > 0 ? opt.transferSlackS : 0);
    const options = [];
    for (const option of [ride, ...alternativesFor(graph, ride)]) {
      const op = option.pattern;
      if (!board(op, op.frac[option.boardPos], ready)) continue;
      const time = (op.frac[option.alightPos] - op.frac[option.boardPos]) * bDur;
      options.push({ ...option, depart: bDepart, gap: bGap, freq: bFreq, time, arrive: bDepart + time });
    }
    if (!options.length) return;
    const main = options.reduce((a, b) => (b.arrive < a.arrive ? b : a));
    const pat = main.pattern;
    const rideTime = main.time;
    const alts = [];
    let rate = 0;         // autobuses por segundo, sumando las líneas frecuentes
    let fixed = Infinity; // primera salida «de horario»
    for (const option of options) {
      if (option !== main && option.arrive > main.arrive + 240) continue;
      if (option !== main) alts.push(option.pattern);
      if (option.freq) rate += 1 / option.gap;
      else fixed = Math.min(fixed, option.depart);
    }
    const gap = rate > 0 ? 1 / rate : main.gap;
    const depart = Math.min(rate > 0 ? ready + gap / 2 : Infinity, fixed);
    const arrive = depart + rideTime;

    legs.push({
      type: 'ride',
      net: pat.net,
      line: pat.line,
      dir: pat.dir,
      pattern: pat.index,
      altLines: alts.map((a) => ({ net: a.net, line: a.line })),
      exact: pat.exact,         // red de horario (CRTM): la hora de salida es la del horario oficial
      estimated: pat.estimated, // tiempos de recorrido estimados (el GTFS no trae horas de paso)
      board: boardStop,
      alight: alightStop,
      stops: Array.from(pat.stops.subarray(main.boardPos, main.alightPos + 1), (s) => stops[s]),
      wait: depart - t,
      gap,                      // cada cuánto pasa un autobús que sirve (s)
      scheduled: !(rate > 0 && depart < fixed), // true: se espera a una salida concreta
      depart,
      arrive,
      time: rideTime,
    });
    waitTime += depart - t;
    t = arrive;
    here = alightStop;
  });

  const rideLegs = legs.filter((l) => l.type === 'ride');
  if (rideLegs.length !== rides.length) return null; // algún autobús ya no pasa
  walkTo(q.to, 'egress');

  const transfers = rideLegs.length - 1;
  const duration = t - q.t0;
  return {
    legs,
    depart: q.t0,
    arrive: t,
    duration,
    transfers,
    walkTime,
    walkDist,
    waitTime,
    lines: rideLegs.map((l) => l.line),
    cost: duration + transfers * opt.transferPenaltyS + 0.5 * walkTime,
  };
}

/**
 * Parecido entre dos itinerarios (0..1): fracción de las paradas por las que
 * se pasa en autobús que quedan a menos de 150 m de alguna del otro. Así dos
 * líneas distintas que van por la misma calle cuentan como «la misma ruta».
 */
function overlap(a, b) {
  const pa = a.legs.filter((l) => l.type === 'ride').flatMap((l) => l.stops);
  const pb = b.legs.filter((l) => l.type === 'ride').flatMap((l) => l.stops);
  if (!pa.length || !pb.length) return 0;
  const near = (p, list) => list.some((o) => (
    Math.abs(o.lat - p.lat) < 0.0015 && Math.abs(o.lon - p.lon) < 0.002
    && distanceM(p.lat, p.lon, o.lat, o.lon) <= 150));
  const hits = pa.filter((p) => near(p, pb)).length + pb.filter((p) => near(p, pa)).length;
  return hits / (pa.length + pb.length);
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

/** Paradas alcanzables andando desde un punto: Map(parada -> segundos). */
function walkableStops(graph, place) {
  const { opt, grid, walkSecPerM } = graph;
  let hits = grid.within(place.lat, place.lon, opt.accessMaxM);
  if (hits.length < 2) hits = grid.within(place.lat, place.lon, opt.accessFallbackM).slice(0, 6);
  return new Map(hits.map((hit) => [hit.index, hit.dist * walkSecPerM]));
}

/**
 * Calcula las mejores rutas entre dos puntos.
 *
 * @param {object} graph   de buildGraph()
 * @param {object} query   {from: {lat, lon, name}, to: {lat, lon, name},
 *                          date: 'AAAA-MM-DD', time: segundos desde las 0:00}
 * @returns {{routes: Array, walk: object|null, stale: boolean, reason: string|null}}
 */
export function planRoutes(graph, query) {
  const { opt, patterns, lineKeys } = graph;
  const day = prepareDay(graph, query.date);
  const q = {
    from: query.from,
    to: query.to,
    t0: query.time,
    access: walkableStops(graph, query.from),
    egress: walkableStops(graph, query.to),
  };
  const result = { routes: [], walk: null, stale: day.stale, reason: null };

  // Ir andando, si está cerca
  const straight = distanceM(q.from.lat, q.from.lon, q.to.lat, q.to.lon);
  if (straight <= opt.walkOnlyMaxM) {
    const time = straight * graph.walkSecPerM;
    result.walk = { dist: straight * opt.walkDetour, time, depart: q.t0, arrive: q.t0 + time };
  }
  if (!q.access.size || !q.egress.size) {
    result.reason = !q.access.size ? 'no-stops-from' : 'no-stops-to';
    return result;
  }

  // 1) Candidatos: una búsqueda normal y varias más vetando las líneas de la
  //    mejor ruta encontrada hasta entonces (enteras, o solo las de un tramo).
  const pool = new Map();
  const banned = new Uint8Array(patterns.length);
  const ban = (lines) => {
    for (const key of lines) for (const p of lineKeys.get(key)) banned[p] = 1;
  };
  const search = () => {
    let bestOfRun = null;
    for (const rides of raptor(graph, q, banned)) {
      const id = rides.map((r) => `${r.pattern.index}:${r.boardPos}:${r.alightPos}`).join('|');
      if (!pool.has(id)) {
        const itinerary = buildItinerary(graph, q, rides);
        if (itinerary) pool.set(id, itinerary);
      }
      const itinerary = pool.get(id);
      if (itinerary && (!bestOfRun || itinerary.cost < bestOfRun.cost)) bestOfRun = itinerary;
    }
    return bestOfRun;
  };
  const linesOf = (itinerary) => itinerary.legs
    .filter((l) => l.type === 'ride')
    .map((l) => [l.line, ...l.altLines.map((a) => a.line)]);

  const first = search();
  if (first) {
    const limit = first.cost * 2 + 900;
    // a) vetando cada vez todas las líneas de la mejor ruta de la ronda anterior
    let current = first;
    for (let i = 0; i < 8 && current && current.cost <= limit; i++) {
      ban(linesOf(current).flat());
      current = search();
    }
    // b) vetando solo las líneas de un tramo de la mejor ruta
    const groups = linesOf(first);
    if (groups.length > 1) {
      for (const group of groups) {
        banned.fill(0);
        ban(group);
        search();
      }
    }
  }

  // 2) Selección: las de menor coste que sean variantes de verdad.
  const candidates = [...pool.values()].sort((a, b) => a.cost - b.cost);
  if (!candidates.length) {
    result.reason = 'no-service';
    return result;
  }
  const bestDuration = Math.min(...candidates.map((c) => c.duration));
  const reasonable = candidates.filter((c) => (
    c.duration <= bestDuration * 1.6 + 600
    // ...y si se puede ir andando, que el autobús ahorre tiempo y pasos
    && (!result.walk || (c.duration < result.walk.time - 60 && c.walkTime < result.walk.time * 0.7))
  ));
  if (!reasonable.length) {
    result.reason = 'walk-is-better';
    return result;
  }
  // Tres pasadas, de más a menos exigente, hasta tener las rutas pedidas:
  //   1. buenas (coste parecido al de la mejor) y por sitios distintos;
  //   2. buenas que comparten parte del camino, pero con otras líneas;
  //   3. por sitios distintos aunque sean bastante peores.
  const chosen = [];
  const goodCost = reasonable[0].cost * 1.35 + 300;
  const maxTransfers = Math.min(...reasonable.map((c) => c.transfers)) + 2;
  const passes = [
    { maxOverlap: 0.6, maxCost: goodCost },
    { maxOverlap: 0.85, maxCost: goodCost },
    { maxOverlap: 0.6, maxCost: Infinity },
  ];
  for (const pass of passes) {
    for (const candidate of reasonable) {
      if (chosen.length >= opt.maxRoutes) break;
      if (chosen.includes(candidate) || candidate.cost > pass.maxCost) continue;
      if (candidate.transfers > maxTransfers) continue;
      const key = candidate.lines.join('>');
      const similar = chosen.some((c) => c.lines.join('>') === key || overlap(c, candidate) >= pass.maxOverlap);
      if (!similar) chosen.push(candidate);
    }
  }
  result.routes = chosen.sort((a, b) => a.cost - b.cost);
  return result;
}
