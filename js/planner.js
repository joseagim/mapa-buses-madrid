// Modo «Ruta»: formulario de origen y destino, cálculo con js/router.js,
// lista de rutas y dibujo de la ruta elegida en el mapa.
/* global L */

import { NETWORKS, PALETTE } from './config.js';
import { loadRouting } from './data.js';
import { $, h, isMobile, toast, formatMinutes, formatMeters, formatClock } from './dom.js';
import { textColorFor } from './geo.js';
import { createPlaceInput, mapPlace } from './places.js';
import { reverseGeocode } from './geocode.js';
import { buildGraph, planRoutes } from './router.js';
import { parsePoint } from './urlstate.js';

const NAVY = '#0b2545';
const KY = 110540;
const KX = 111320 * Math.cos((40.42 * Math.PI) / 180);
const WHICH = { from: { letter: 'A', label: 'origen' }, to: { letter: 'B', label: 'destino' } };

const WALK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="1.6" fill="currentColor" stroke="none"/><path d="M13 8.5l-3 5.5 3 3-1 5M10 14l-2 7M12.2 9.5L8.6 11.6 8 15M13.6 9.6l2.2 3 2.7 1"/></svg>';

/** Fecha y hora actuales en Madrid, esté donde esté el navegador. */
function madridNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second),
    local: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`,
  };
}

const WHEN_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;
const LONG_WAIT_S = 30 * 60; // a partir de aquí una espera se avisa como «larga»

export function initPlanner(ctx) {
  const { map, data } = ctx;

  const st = {
    active: false,
    from: null,
    to: null,
    when: null,       // 'AAAA-MM-DDTHH:MM' o null (= ahora)
    result: null,     // lo que devuelve planRoutes
    options: [],      // rutas en autobús y, si procede, «a pie»
    selected: 0,
    armed: null,      // 'from' | 'to': el próximo toque en el mapa lo elige
    colors: new Map(),
    message: null,
  };

  // --- Capas del mapa -------------------------------------------------------
  const lineLayer = L.layerGroup();   // recorrido de la ruta elegida
  const pinLayer = L.layerGroup();    // origen y destino
  const pins = {};
  const pickPopup = L.popup({ maxWidth: 240, minWidth: 180, className: 'pick-popup' });

  // --- Formulario -----------------------------------------------------------
  const inputs = {};
  for (const which of ['from', 'to']) {
    inputs[which] = createPlaceInput({
      label: which === 'from' ? 'Origen' : 'Destino',
      placeholder: which === 'from' ? 'Origen: parada, calle o lugar' : 'Destino: parada, calle o lugar',
      marker: WHICH[which].letter,
      markerClass: which === 'from' ? 'a' : 'b',
      stops: () => ctx.visibleStops(),
      lineNames: ctx.lineMinis,
      near: () => { const c = map.getCenter(); return { lat: c.lat, lon: c.lng }; },
      onChange: (place) => {
        st[which] = place;
        compute();
      },
      onPickOnMap: () => arm(which),
    });
  }

  const whenSelect = h('select', { class: 'when-select', 'aria-label': 'Hora de salida', onchange: onWhenMode },
    h('option', { value: 'now', text: 'Salir ahora' }),
    h('option', { value: 'at', text: 'Salir a otra hora…' }),
  );
  const whenInput = h('input', {
    type: 'datetime-local', class: 'when-input', hidden: true, 'aria-label': 'Fecha y hora de salida',
    onchange: () => {
      if (!WHEN_RE.test(whenInput.value)) return;
      st.when = whenInput.value;
      compute({ raise: false });
    },
  });

  function onWhenMode() {
    if (whenSelect.value === 'now') {
      st.when = null;
      whenInput.hidden = true;
    } else {
      whenInput.value = st.when || madridNow().local;
      st.when = whenInput.value;
      whenInput.hidden = false;
    }
    compute({ raise: false });
  }

  $('#route-form').append(
    h('div', { class: 'route-fields' },
      h('div', { class: 'route-inputs' }, inputs.from.el, inputs.to.el),
      h('button', {
        type: 'button', class: 'icon swap', title: 'Intercambiar origen y destino',
        'aria-label': 'Intercambiar origen y destino', onclick: swap, text: '⇅',
      }),
    ),
    h('div', { class: 'when' }, whenSelect, whenInput),
  );
  const resultsBox = $('#route-results');

  function swap() {
    const { from, to } = st;
    st.from = to;
    st.to = from;
    inputs.from.set(st.from, { silent: true });
    inputs.to.set(st.to, { silent: true });
    compute();
  }

  // --- Elegir puntos en el mapa --------------------------------------------
  function arm(which) {
    st.armed = which;
    toast(`Toca el mapa para elegir el ${WHICH[which].label}.`, 6000);
    if (isMobile()) ctx.setPanelCollapsed(true);
  }

  function setEndpoint(which, place) {
    st.armed = null;
    st[which] = place;
    inputs[which].set(place, { silent: true });
    if (place.kind === 'map') {
      reverseGeocode(place.lat, place.lon).then((name) => {
        inputs[which].rename(place, name);
        if (st[which] === place && name) {
          renderResults();
          ctx.updateUrl();
        }
      });
    }
    compute();
  }

  function onMapClick(latlng) {
    const place = () => mapPlace(latlng.lat, latlng.lng);
    if (st.armed) {
      setEndpoint(st.armed, place());
      return true;
    }
    // Sin nada pendiente: se pregunta qué es ese punto.
    const choose = (which) => {
      map.closePopup(pickPopup);
      setEndpoint(which, place());
    };
    pickPopup.setLatLng(latlng).setContent(h('div', { class: 'pick' },
      h('button', { type: 'button', class: 'btn small', onclick: () => choose('from'), text: 'Salir de aquí' }),
      h('button', { type: 'button', class: 'btn small', onclick: () => choose('to'), text: 'Llegar aquí' }),
    )).openOn(map);
    return false;
  }

  // --- Cálculo ----------------------------------------------------------------
  // Un grafo por combinación de redes visibles (se guarda: cambiar de redes y
  // volver no recalcula nada). Cada red aporta su routing.json, que se descarga
  // una sola vez; los transbordos a pie entre redes salen de las coordenadas.
  const graphs = new Map();
  function ensureGraph() {
    const nets = ctx.enabledNets();
    const key = nets.join(',');
    if (!graphs.has(key)) {
      const promise = Promise.all(nets.map((id) => loadRouting(data, id))).then((parts) => buildGraph(parts));
      promise.catch(() => graphs.delete(key));
      graphs.set(key, promise);
    }
    return graphs.get(key);
  }
  const graphReady = () => graphs.has(ctx.enabledNets().join(','));

  function currentWhen() {
    const match = st.when && WHEN_RE.exec(st.when);
    if (!match) return madridNow();
    return { date: match[1], time: Number(match[2]) * 3600 + Number(match[3]) * 60, local: st.when };
  }

  let ticket = 0;
  /**
   * Recalcula las rutas. `raise`: en móvil, deja la hoja a media pantalla para
   * que se vean a la vez el mapa y las opciones (solo cuando cambia el origen
   * o el destino, no al cambiar la hora).
   */
  async function compute({ fit = true, select: wanted = 0, raise = true } = {}) {
    const mine = ++ticket;
    if (raise && isMobile() && st.active) ctx.setSheet('half');
    ctx.updateUrl();
    drawPins();
    st.result = null;
    st.options = [];
    st.selected = 0;
    st.message = null;
    if (!st.from || !st.to) {
      renderResults();
      drawRoute(false);
      ctx.renderSummary();
      return;
    }
    let graph;
    try {
      if (!graphReady()) {
        st.message = 'Cargando los horarios…';
        renderResults();
      }
      graph = await ensureGraph();
    } catch (error) {
      console.error(error);
      if (mine !== ticket) return;
      st.message = 'No se han podido cargar los datos de rutas. Revisa la conexión y vuelve a intentarlo.';
      renderResults();
      return;
    }
    if (mine !== ticket) return;

    const when = currentWhen();
    const result = planRoutes(graph, { from: st.from, to: st.to, date: when.date, time: when.time });
    st.result = result;
    st.message = null;
    st.options = result.routes.map((route) => ({ kind: 'bus', ...route }));
    if (result.walk) {
      st.options.push({
        kind: 'walk',
        legs: [{ type: 'walk', kind: 'direct', from: st.from, to: st.to, dist: result.walk.dist, time: result.walk.time, start: result.walk.depart, end: result.walk.arrive }],
        depart: result.walk.depart, arrive: result.walk.arrive, duration: result.walk.time,
        transfers: 0, walkTime: result.walk.time, walkDist: result.walk.dist, waitTime: 0,
      });
    }
    if (wanted > 0 && wanted < st.options.length) st.selected = wanted;
    assignColors();
    renderResults();
    ctx.renderSummary();
    await drawRoute(fit);
  }

  /** Un color por línea: el que tenga en el modo Líneas o uno libre de la paleta. */
  function assignColors() {
    st.colors = new Map();
    const used = new Set(ctx.state.selected.map((s) => s.color));
    for (const option of st.options) {
      for (const leg of option.legs) {
        if (leg.type !== 'ride') continue;
        for (const id of [leg.line, ...leg.altLines.map((a) => a.line)]) {
          if (st.colors.has(id)) continue;
          const color = ctx.selectionOf(id)?.color
            || PALETTE.find((c) => !used.has(c))
            || PALETTE[st.colors.size % PALETTE.length];
          used.add(color);
          st.colors.set(id, color);
        }
      }
    }
  }

  // --- Lista de rutas -----------------------------------------------------------
  const walkIcon = () => {
    const span = h('span', { class: 'ico-walk', 'aria-hidden': 'true' });
    span.innerHTML = WALK_SVG;
    return span;
  };

  const lineBadge = (id) => {
    const line = data.lineById.get(id);
    return line ? ctx.badge(line, st.colors.get(id)) : h('span', { class: 'badge', text: id });
  };

  const stopLink = (stop) => h('button', {
    type: 'button', class: 'stop-link', title: 'Ver la parada en el mapa',
    onclick: (e) => {
      e.stopPropagation();
      ctx.focusStop(stop);
    },
  }, h('strong', { text: stop.name }), h('small', { text: ` nº ${stop.code}` }));

  function tagsFor(options) {
    const buses = options.filter((o) => o.kind === 'bus');
    const tags = new Map();
    if (buses.length < 2) return tags;
    const fastest = buses.reduce((a, b) => (b.duration < a.duration ? b : a));
    tags.set(fastest, 'La más rápida');
    const fewest = buses.reduce((a, b) => (b.transfers < a.transfers ? b : a));
    if (fewest.transfers < fastest.transfers) tags.set(fewest, 'Menos transbordos');
    const leastWalk = buses.reduce((a, b) => (b.walkTime < a.walkTime ? b : a));
    if (!tags.has(leastWalk) && buses.every((o) => o === leastWalk || o.walkTime - leastWalk.walkTime >= 180)) {
      tags.set(leastWalk, 'Menos a pie');
    }
    return tags;
  }

  function legChips(option) {
    const chips = [];
    for (const leg of option.legs) {
      let chip;
      if (leg.type === 'walk') {
        if (leg.time < 150 && option.kind === 'bus') continue; // los paseos cortos solo salen en el paso a paso
        chip = h('span', { class: 'walk-pill', title: 'A pie' }, walkIcon(), formatMinutes(leg.time));
      } else {
        chip = h('span', { class: 'leg-lines' }, lineBadge(leg.line),
          leg.altLines.length ? h('small', { text: `+${leg.altLines.length}`, title: 'Otras líneas que también sirven' }) : null);
      }
      if (chips.length) chips.push(h('span', { class: 'leg-sep', 'aria-hidden': 'true', text: '›' }));
      chips.push(chip);
    }
    return chips;
  }

  function subtitle(option) {
    if (option.kind === 'walk') return `${formatMeters(option.walkDist)} andando, sin autobús`;
    const transfers = option.transfers === 0 ? 'Sin transbordos'
      : option.transfers === 1 ? '1 transbordo' : `${option.transfers} transbordos`;
    return `${transfers} · ${formatMinutes(option.walkTime)} a pie · ${formatMinutes(option.waitTime)} de espera`;
  }

  function waitText(leg) {
    const every = leg.gap > 0 ? `pasa cada ${formatMinutes(leg.gap)}` : null;
    if (leg.exact) {
      // Redes de horario (CRTM): la hora es la del horario oficial
      const wait = leg.wait >= 60 ? ` · espera de ${formatMinutes(leg.wait)}` : '';
      return `Sale a las ${formatClock(leg.depart)} según el horario${wait}`;
    }
    if (leg.scheduled) {
      return `Sale a las ${formatClock(leg.depart)}${every ? ` (${every})` : ''} · espera de ${formatMinutes(leg.wait)}`;
    }
    return `Espera de unos ${formatMinutes(leg.wait)}${every ? ` (${every})` : ''}`;
  }

  function rideStep(leg) {
    const line = data.lineById.get(leg.line);
    const headsign = line?.dirs.find((d) => d.dir === leg.dir)?.headsign;
    const count = leg.stops.length - 1;
    const middle = leg.stops.slice(1, -1);
    return h('li', { class: 'step ride', style: `--c:${st.colors.get(leg.line) || NAVY}` },
      h('div', { class: 'step-lines' },
        lineBadge(leg.line),
        leg.altLines.map((alt) => lineBadge(alt.line)),
        headsign ? h('span', { class: 'step-head', text: `hacia ${headsign}` }) : null,
      ),
      leg.altLines.length ? h('div', { class: 'step-note', text: 'Te vale cualquiera de estas líneas: coge la primera que pase.' }) : null,
      h('div', { class: 'step-row' }, h('span', { class: 'step-time', text: formatClock(leg.depart) }), h('span', {}, 'Sube en ', stopLink(leg.board))),
      h('div', { class: 'step-note', text: waitText(leg) }),
      leg.estimated ? h('div', { class: 'step-note warn', text: 'El GTFS no trae las horas de paso de esta línea: la duración del viaje es una estimación.' }) : null,
      middle.length
        ? h('details', { class: 'step-stops' },
          h('summary', { text: `${count} paradas · ${formatMinutes(leg.time)}` }),
          h('ol', {}, middle.map((stop) => h('li', { text: stop.name }))))
        : h('div', { class: 'step-note', text: `1 parada · ${formatMinutes(leg.time)}` }),
      h('div', { class: 'step-row' }, h('span', { class: 'step-time', text: formatClock(leg.arrive) }), h('span', {}, 'Baja en ', stopLink(leg.alight))),
    );
  }

  function walkStep(leg) {
    const target = leg.kind === 'egress' || leg.kind === 'direct'
      ? h('strong', { text: leg.to.name })
      : stopLink(leg.to);
    return h('li', { class: 'step walk' },
      h('div', { class: 'step-row' }, walkIcon(),
        h('span', {}, `${leg.kind === 'transfer' ? 'Transbordo a pie' : 'A pie'}: ${formatMinutes(leg.time)} (${formatMeters(leg.dist)}) hasta `, target)),
    );
  }

  function routeDetail(option) {
    const steps = h('ol', { class: 'steps' });
    steps.append(h('li', { class: 'step end' },
      h('span', { class: 'place-marker a', text: 'A' }),
      h('span', {}, h('strong', { text: st.from.name }), h('small', { text: ` · salida ${formatClock(option.depart)}` }))));
    option.legs.forEach((leg, i) => {
      const previous = option.legs[i - 1];
      if (leg.type === 'ride' && previous?.type === 'ride') {
        steps.append(h('li', { class: 'step walk' }, h('div', { class: 'step-row' }, h('span', { class: 'ico-same' }), h('span', { text: 'Transbordo en la misma parada' }))));
      }
      steps.append(leg.type === 'ride' ? rideStep(leg) : walkStep(leg));
    });
    steps.append(h('li', { class: 'step end' },
      h('span', { class: 'place-marker b', text: 'B' }),
      h('span', {}, h('strong', { text: st.to.name }), h('small', { text: ` · llegada hacia las ${formatClock(option.arrive)}` }))));
    return h('div', { class: 'route-detail' },
      h('h2', { class: 'section-title', text: option.kind === 'walk' ? 'Paso a paso' : 'Paso a paso de la ruta elegida' }),
      steps);
  }

  function renderResults() {
    resultsBox.replaceChildren();
    if (st.message) {
      resultsBox.append(h('p', { class: 'empty', text: st.message }));
      return;
    }
    if (!st.from || !st.to) {
      resultsBox.append(h('div', { class: 'hint' },
        h('p', { text: 'Escribe el origen y el destino (una parada, una calle o un lugar) o toca el mapa para elegirlos. Verás las mejores rutas en autobús, combinando EMT, interurbanos y urbanos de otros municipios.' }),
        h('p', { class: 'hint-small', text: 'Los tiempos salen de los horarios y frecuencias oficiales, no del tráfico real. Con «Redes», sobre el mapa, eliges qué redes entran en el cálculo.' }),
      ));
      return;
    }
    const result = st.result;
    if (!result) return;
    if (result.stale) {
      resultsBox.append(h('p', { class: 'notice', text: 'Los datos no cubren esa fecha: se usan los horarios de ese día de la semana.' }));
    }
    const hidden = NETWORKS.filter((net) => !ctx.state.nets.has(net.id)).map((net) => net.short);
    if (hidden.length) {
      resultsBox.append(h('p', { class: 'notice soft', text: `No se están usando: ${hidden.join(' ni ')}. Actívalas en «Redes», sobre el mapa, si quieres combinarlas.` }));
    }
    const reasons = {
      'no-stops-from': 'No hay paradas cerca del origen (a menos de 1,5 km) en las redes activas.',
      'no-stops-to': 'No hay paradas cerca del destino (a menos de 1,5 km) en las redes activas.',
      'no-service': 'No se ha encontrado ninguna ruta en autobús a esa hora con las redes activas.',
      'walk-is-better': 'Está muy cerca: en autobús no se gana tiempo.',
    };
    if (result.reason) resultsBox.append(h('p', { class: 'notice', text: reasons[result.reason] }));
    if (!st.options.length) return;

    const tags = tagsFor(st.options);
    const longWait = (option) => option.legs.some((leg) => leg.type === 'ride' && leg.wait >= LONG_WAIT_S);
    if (st.options[0].kind === 'bus' && longWait(st.options[0])) {
      resultsBox.append(h('p', { class: 'notice', text: 'A esa hora hay poco servicio: la mejor ruta tiene esperas largas. Mira a qué hora sale cada autobús.' }));
    }
    const list = h('ol', { class: 'route-list' });
    st.options.forEach((option, index) => {
      const on = index === st.selected;
      const tag = option.kind === 'walk' ? 'A pie' : longWait(option) ? 'Espera larga' : tags.get(option);
      list.append(h('li', { class: `route${on ? ' on' : ''}` },
        h('button', { type: 'button', class: 'route-head', 'aria-expanded': String(on), onclick: () => select(index) },
          h('span', { class: 'route-top' },
            h('strong', { class: 'route-time', text: formatMinutes(option.duration) }),
            h('span', { class: 'route-clock', text: `${formatClock(option.depart)} → ${formatClock(option.arrive)}` }),
            tag ? h('span', { class: `route-tag${tag === 'Espera larga' ? ' warn' : ''}`, text: tag }) : null,
          ),
          h('span', { class: 'route-legs' }, legChips(option)),
          h('span', { class: 'route-sub', text: subtitle(option) }),
        ),
      ));
    });
    // Arriba las opciones, para compararlas de un vistazo; debajo, el detalle de la elegida.
    resultsBox.append(list, routeDetail(st.options[st.selected]));
  }

  function select(index) {
    if (index === st.selected) {
      drawRoute(true); // volver a encuadrar la ruta
      if (isMobile()) ctx.setPanelCollapsed(true);
      return;
    }
    st.selected = index;
    renderResults();
    ctx.renderSummary();
    ctx.updateUrl();
    drawRoute(true);
  }

  // --- Dibujo en el mapa ----------------------------------------------------------
  function drawPins() {
    for (const which of ['from', 'to']) {
      const place = st[which];
      if (!place) {
        if (pins[which]) pinLayer.removeLayer(pins[which]);
        pins[which] = null;
        continue;
      }
      if (!pins[which]) {
        pins[which] = L.marker([place.lat, place.lon], {
          draggable: true, keyboard: false, zIndexOffset: which === 'to' ? 100 : 0,
          title: `${which === 'from' ? 'Origen' : 'Destino'} (arrástralo para moverlo)`,
          icon: L.divIcon({ className: `pin pin-${which === 'from' ? 'a' : 'b'}`, html: WHICH[which].letter, iconSize: [30, 30], iconAnchor: [15, 15] }),
        }).on('dragend', (e) => {
          const pos = e.target.getLatLng();
          setEndpoint(which, mapPlace(pos.lat, pos.lng));
        }).addTo(pinLayer);
      } else {
        pins[which].setLatLng([place.lat, place.lon]);
      }
    }
  }

  /** Índice del punto del trazado más cercano a cada parada de un sentido de línea. */
  function stopTrackIndexes(dir) {
    if (dir.stopIdx) return dir.stopIdx;
    const { lat, lon, n } = dir.track;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      cum[i] = cum[i - 1] + Math.hypot((lon[i] - lon[i - 1]) * KX, (lat[i] - lat[i - 1]) * KY);
    }
    const indexes = [];
    let from = 0;
    dir.stops.forEach((id, k) => {
      const stop = data.stopById.get(id);
      if (!stop) {
        indexes.push(from);
        return;
      }
      // Se busca hacia delante, y solo hasta donde puede estar la parada según
      // la distancia del GTFS: así no se salta a otra pasada por la misma calle.
      const step = k > 0 && dir.dist?.[k] != null && dir.dist[k - 1] != null ? dir.dist[k] - dir.dist[k - 1] : null;
      const reach = k === 0 ? 400 : step != null ? step * 1.5 + 200 : Infinity;
      let best = from;
      let bestDist = Infinity;
      for (let i = from; i < n && cum[i] - cum[from] <= reach; i++) {
        const d = Math.hypot((lon[i] - stop.lon) * KX, (lat[i] - stop.lat) * KY);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      indexes.push(best);
      from = best;
    });
    dir.stopIdx = indexes;
    return indexes;
  }

  /**
   * Trazado por las calles de un tramo en autobús.
   *
   * Solo se guarda el trazado del recorrido principal de cada línea y sentido,
   * y un viaje puede ir por una variante (saltarse paradas, entrar a una
   * urbanización...). Por eso se avanza parada a parada: mientras dos paradas
   * consecutivas del tramo estén también, y en ese orden, en el recorrido
   * principal, se sigue su trazado; donde no, se unen en línea recta.
   */
  async function legPath(leg) {
    const straight = leg.stops.map((s) => [s.lat, s.lon]);
    try {
      const file = await ctx.loadLine(leg.line);
      const dir = file.dirs.find((d) => d.dir === leg.dir);
      if (!dir) return straight;
      const indexes = stopTrackIndexes(dir);
      const { lat, lon } = dir.track;
      const where = new Map(); // id de parada -> posiciones en el recorrido principal
      dir.stops.forEach((id, k) => {
        if (!where.has(id)) where.set(id, []);
        where.get(id).push(k);
      });
      const after = (id, k) => where.get(id)?.find((pos) => pos > k) ?? -1;

      const points = [straight[0]];
      let last = after(leg.stops[0].id, -1); // posición de la última parada encontrada
      let chained = last >= 0;               // ¿la parada anterior estaba en el recorrido?
      for (let i = 1; i < leg.stops.length; i++) {
        const k = after(leg.stops[i].id, last);
        if (chained && k >= 0 && indexes[k] > indexes[last]) {
          for (let j = indexes[last] + 1; j <= indexes[k]; j++) points.push([lat[j], lon[j]]);
        } else {
          points.push(straight[i]);
        }
        chained = k >= 0;
        if (k >= 0) last = k;
      }
      return points;
    } catch {
      return straight;
    }
  }

  let drawTicket = 0;
  async function drawRoute(fit) {
    const mine = ++drawTicket;
    const option = st.options[st.selected];
    if (!st.active || !option) {
      lineLayer.clearLayers();
      if (fit && option) st.pendingFit = true; // se encuadrará al entrar en el modo
      return;
    }
    const rides = option.legs.filter((l) => l.type === 'ride');
    const paths = await Promise.all(rides.map(legPath));
    if (mine !== drawTicket) return;
    lineLayer.clearLayers();

    const bounds = L.latLngBounds([[st.from.lat, st.from.lon], [st.to.lat, st.to.lon]]);
    const { renderers } = ctx;
    for (const leg of option.legs) {
      if (leg.type === 'walk') {
        L.polyline([[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]], {
          renderer: renderers.routes, pane: 'routes', interactive: false,
          color: NAVY, weight: 4, dashArray: '1 8', lineCap: 'round',
        }).addTo(lineLayer);
        continue;
      }
      const path = paths[rides.indexOf(leg)];
      const color = st.colors.get(leg.line) || NAVY;
      bounds.extend(path);
      L.polyline(path, {
        renderer: renderers.casing, pane: 'casing', interactive: false,
        color: '#fff', weight: 9, opacity: 0.95, lineJoin: 'round',
      }).addTo(lineLayer);
      L.polyline(path, {
        renderer: renderers.routes, pane: 'routes', interactive: false,
        color, weight: 6, opacity: 1, lineJoin: 'round',
      }).addTo(lineLayer);
      leg.stops.forEach((stop, i) => {
        const end = i === 0 || i === leg.stops.length - 1;
        const marker = L.circleMarker([stop.lat, stop.lon], {
          renderer: renderers.journey, pane: 'journey', bubblingMouseEvents: false,
          radius: end ? 7 : 3.5, color: end ? color : '#fff', weight: end ? 3.5 : 1.5,
          fillColor: end ? '#fff' : color, fillOpacity: 1,
        }).on('click', () => ctx.openStop(stop)).addTo(lineLayer);
        if (end) {
          marker.bindTooltip(`${i === 0 ? 'Sube' : 'Baja'}: ${stop.name}`, { direction: 'top', offset: [0, -6] });
        }
      });
    }
    if (fit) map.fitBounds(bounds, { ...ctx.viewPadding(), maxZoom: 16 });
  }

  // --- Lo que usa app.js -------------------------------------------------------------
  const encodePlace = (place) => (place ? `${place.lat.toFixed(5)},${place.lon.toFixed(5)},${place.name}` : null);

  return {
    setEndpoint,
    onMapClick,
    onSelection() {},

    /** Han cambiado las redes visibles: se recalcula con las que queden. */
    onNets() {
      compute({ fit: false, raise: false });
    },

    activate() {
      st.active = true;
      lineLayer.addTo(map);
      pinLayer.addTo(map);
      ensureGraph().catch(() => {}); // se va cargando mientras el usuario escribe
      drawRoute(Boolean(st.pendingFit));
      st.pendingFit = false;
    },

    deactivate() {
      st.active = false;
      st.armed = null;
      map.closePopup(pickPopup);
      lineLayer.remove();
      pinLayer.remove();
    },

    /** Resumen para la cabecera del panel plegado. */
    summary() {
      const option = st.options[st.selected];
      if (!option) return [h('span', { class: 'summary-text', text: 'Ruta' })];
      return [
        h('span', { class: 'summary-text', text: formatMinutes(option.duration) }),
        ...option.legs.filter((l) => l.type === 'ride').map((l) => lineBadge(l.line)),
        option.kind === 'walk' ? h('span', { class: 'summary-text', text: 'a pie' }) : null,
      ].filter(Boolean);
    },

    urlParams() {
      return { o: encodePlace(st.from), d: encodePlace(st.to), h: st.when, r: st.selected > 0 ? st.selected + 1 : null };
    },

    /** Aplica el estado de la URL. `keepView`: no mover el mapa (la URL trae su vista). */
    applyParams(params, keepView) {
      // Si la URL describe lo que ya hay (p. ej. solo ha cambiado la vista del
      // mapa), no se recalcula ni se pierde la ruta elegida.
      const now = this.urlParams();
      if (['o', 'd', 'h'].every((key) => (params[key] || null) === (now[key] || null)) && (st.from || st.to)) return;
      for (const [which, key] of [['from', 'o'], ['to', 'd']]) {
        const point = parsePoint(params[key]);
        st[which] = point
          ? { lat: point.lat, lon: point.lon, name: point.rest.join(',') || 'Punto del mapa', kind: 'address' }
          : null;
        inputs[which].set(st[which], { silent: true });
      }
      st.when = WHEN_RE.test(params.h || '') ? params.h : null;
      whenSelect.value = st.when ? 'at' : 'now';
      whenInput.hidden = !st.when;
      if (st.when) whenInput.value = st.when;
      compute({ fit: !keepView, select: (Number(params.r) || 1) - 1 });
    },
  };
}
