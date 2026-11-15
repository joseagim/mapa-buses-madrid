// Prueba del buscador de rutas con trayectos reales. Sin dependencias:
//
//     node tests/router.test.mjs            (comprueba y resume)
//     node tests/router.test.mjs --verbose  (enseña cada ruta tramo a tramo)
//
// Comprueba cosas de sentido común (hay rutas, los tiempos son creíbles, las
// variantes usan líneas distintas, el calendario distingue laborables, sábados
// y festivos...). Sirve para revisar que todo sigue bien después de actualizar
// los datos o tocar js/router.js.

import { readFileSync, existsSync } from 'node:fs';
import { NETWORKS } from '../js/config.js';
import { createStore, addIndex, addStops } from '../js/data.js';
import { buildGraph, planRoutes, activeSets } from '../js/router.js';

const verbose = process.argv.includes('--verbose');
const url = (path) => new URL(`../${path}`, import.meta.url);
const load = (path) => JSON.parse(readFileSync(url(path), 'utf8'));

// --- Datos: todas las redes que estén generadas --------------------------------
const store = createStore();
const nets = [];
for (const def of NETWORKS) {
  if (!existsSync(url(`${def.path}/routing.json`))) {
    console.log(`(sin datos de ${def.name}: se prueba sin esa red)`);
    continue;
  }
  const lines = addIndex(store, def.id, load(`${def.path}/index.json`));
  const stops = addStops(store, def.id, load(`${def.path}/stops.json`));
  nets.push({ id: def.id, stops, lines, routing: load(`${def.path}/routing.json`) });
}
const has = (id) => nets.some((n) => n.id === id);
const label = (id) => store.lineById.get(id)?.label ?? id;

let started = performance.now();
const graph = buildGraph(nets);
console.log(`Grafo: ${nets.map((n) => n.id).join(' + ')} · ${graph.stops.length} paradas, ${graph.patterns.length} recorridos (${Math.round(performance.now() - started)} ms)`);
const onlyEmt = has('emt') ? buildGraph(nets.filter((n) => n.id === 'emt')) : null;

const PLACES = {
  'Cuatro Caminos': [40.4468, -3.7040],
  IFEMA: [40.4664, -3.6172],
  Callao: [40.4203, -3.7059],
  'Avenida de América': [40.4376, -3.6773],
  Atocha: [40.4087, -3.6922],
  'Plaza de Castilla': [40.4660, -3.6894],
  Moncloa: [40.4349, -3.7195],
  'Puerta del Sol': [40.4168, -3.7038],
  Aluche: [40.3857, -3.7604],
  'Vicálvaro': [40.4044, -3.6085],
  'Príncipe Pío': [40.4210, -3.7203],
  // Otros municipios
  'Alcalá de Henares': [40.4820, -3.3640],   // plaza de Cervantes
  'Móstoles': [40.3233, -3.8650],            // Pradillo
  'Las Rozas': [40.4929, -3.8737],           // centro
  'Tres Cantos': [40.6005, -3.7080],         // avenida de Colmenar Viejo
  'Colmenar Viejo': [40.6590, -3.7676],      // centro
  Getafe: [40.3083, -3.7327],
  'Alcobendas': [40.5420, -3.6410],
};
const place = (name) => ({ name, lat: PLACES[name][0], lon: PLACES[name][1] });

// Días dentro del periodo de los datos.
const WEEKDAY = '2026-11-18';   // miércoles laborable
const SATURDAY = '2026-11-21';
const SUNDAY = '2026-11-22';
const HOLIDAY = '2026-12-08';   // martes festivo (lo dice el GTFS de la EMT)
const hm = (text) => { const [h, m] = text.split(':').map(Number); return h * 3600 + m * 60; };
const clock = (s) => {
  const t = Math.round(s / 60);
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const min = (s) => Math.round(s / 60);

// [origen, destino, fecha, hora, minutos mínimos y máximos creíbles para la mejor ruta, redes que debe usar]
const CASES = [
  // Solo EMT (los de la v0.2)
  ['Cuatro Caminos', 'IFEMA', WEEKDAY, '10:00', 40, 80],
  ['Callao', 'Avenida de América', WEEKDAY, '10:00', 15, 45],
  ['Atocha', 'Plaza de Castilla', WEEKDAY, '10:00', 25, 55],
  ['Atocha', 'Plaza de Castilla', WEEKDAY, '08:00', 25, 60],
  ['Moncloa', 'Vicálvaro', WEEKDAY, '18:00', 45, 100],
  ['Aluche', 'Puerta del Sol', SATURDAY, '12:00', 25, 60],
  ['Puerta del Sol', 'Callao', WEEKDAY, '10:00', 3, 15],
  ['Puerta del Sol', 'Plaza de Castilla', WEEKDAY, '03:00', 20, 80], // de madrugada: búhos
  // Entre redes
  ['Alcalá de Henares', 'Avenida de América', WEEKDAY, '10:00', 35, 80, ['inter']],
  // (la 521 ya no llega a Príncipe Pío en el GTFS actual: acaba en Cuatro Vientos)
  ['Móstoles', 'Príncipe Pío', WEEKDAY, '10:00', 40, 110, ['inter']],
  ['Las Rozas', 'Moncloa', WEEKDAY, '10:00', 20, 55, ['inter']],
  ['Tres Cantos', 'Plaza de Castilla', WEEKDAY, '10:00', 20, 55, ['inter']],
  ['Alcobendas', 'Atocha', WEEKDAY, '09:00', 45, 100, ['inter', 'emt']],
  ['Getafe', 'Callao', WEEKDAY, '17:00', 40, 95, ['inter', 'emt']],
  ['Alcalá de Henares', 'Avenida de América', SUNDAY, '10:00', 35, 90, ['inter']],
  ['Las Rozas', 'Moncloa', SATURDAY, '22:30', 20, 70, ['inter']],
  ['Móstoles', 'Príncipe Pío', HOLIDAY, '10:00', 40, 120, ['inter']],
  // Sin datos del corredor de Colmenar Viejo en el GTFS actual: solo se enseña lo que sale
  ['Colmenar Viejo', 'Plaza de Castilla', WEEKDAY, '10:00', 0, 9999],
];

let failures = 0;
const check = (ok, message) => {
  if (!ok) {
    failures++;
    console.log(`   ✗ ${message}`);
  }
};

for (const [from, to, date, time, minMin, maxMin, mustUse] of CASES) {
  if (mustUse && !mustUse.every(has)) continue;
  started = performance.now();
  const result = planRoutes(graph, { from: place(from), to: place(to), date, time: hm(time) });
  const ms = performance.now() - started;
  console.log(`\n${from} → ${to} · ${date} ${time} · ${result.routes.length} rutas (${ms.toFixed(0)} ms)${result.reason ? ` · ${result.reason}` : ''}`);
  if (result.walk) console.log(`   a pie: ${min(result.walk.time)} min (${Math.round(result.walk.dist)} m)`);

  check(result.routes.length > 0 || result.walk || maxMin === 9999, 'no hay ninguna ruta');
  result.routes.forEach((route, i) => {
    const rides = route.legs.filter((l) => l.type === 'ride');
    const summary = rides.map((l) => [l.line, ...l.altLines.map((a) => a.line)].map(label).join('/')).join(' → ');
    console.log(`   ${i + 1}. ${min(route.duration)} min · ${route.transfers} transb. · a pie ${min(route.walkTime)} min · espera ${min(route.waitTime)} min · ${summary}`);
    if (verbose) {
      for (const leg of route.legs) {
        if (leg.type === 'walk') {
          console.log(`        ${clock(leg.start)} a pie ${min(leg.time)} min (${Math.round(leg.dist)} m) hasta ${leg.to.name}`);
        } else {
          console.log(`        ${clock(leg.depart)} ${leg.net} ${label(leg.line)}: ${leg.board.name} (${leg.board.code}) → ${leg.alight.name} (${leg.alight.code}), `
            + `${leg.stops.length - 1} paradas, ${min(leg.time)} min, espera ${min(leg.wait)} min (${leg.scheduled ? 'horario' : `cada ${min(leg.gap)} min`}${leg.estimated ? ', tiempo estimado' : ''})`);
        }
      }
      console.log(`        ${clock(route.arrive)} llegada`);
    }

    // Coherencia interna de cada ruta
    let t = route.depart;
    for (const leg of route.legs) {
      const start = leg.type === 'walk' ? leg.start : leg.depart - leg.wait;
      check(Math.abs(start - t) < 61, `ruta ${i + 1}: los tramos no encajan en el tiempo`);
      t = leg.type === 'walk' ? leg.end : leg.arrive;
    }
    check(Math.abs(t - route.arrive) < 1, `ruta ${i + 1}: la hora de llegada no cuadra`);
    check(rides.every((l) => l.time > 0 && l.wait >= 0), `ruta ${i + 1}: tiempos negativos`);
    check(route.transfers === rides.length - 1, `ruta ${i + 1}: nº de transbordos`);
    // En las redes de horario (CRTM) siempre se espera a una salida concreta
    check(rides.every((l) => !l.exact || l.scheduled), `ruta ${i + 1}: un tramo de horario sale «cada X minutos»`);
    for (let k = 1; k < rides.length; k++) {
      const a = rides[k - 1].alight;
      const b = rides[k].board;
      const d = Math.hypot((a.lat - b.lat) * 110540, (a.lon - b.lon) * 84700);
      check(d <= 305, `ruta ${i + 1}: transbordo a pie de ${Math.round(d)} m`);
    }
  });

  if (result.routes.length) {
    const best = Math.min(...result.routes.map((r) => r.duration)) / 60;
    check(best >= minMin && best <= maxMin, `la mejor ruta tarda ${best.toFixed(0)} min (se esperaba entre ${minMin} y ${maxMin})`);
    const keys = result.routes.map((r) => r.lines.join('>'));
    check(new Set(keys).size === keys.length, 'hay dos rutas con las mismas líneas');
    check(ms < 800, `el cálculo tarda demasiado (${ms.toFixed(0)} ms)`);
    if (mustUse) {
      const used = new Set(result.routes.flatMap((r) => r.legs.filter((l) => l.type === 'ride').map((l) => l.net)));
      check(mustUse.every((id) => used.has(id) || (id === 'inter' && used.has('urb'))), `ninguna ruta usa la red ${mustUse.join(' + ')}`);
    }
  }
}

// --- Calendario ---------------------------------------------------------------
console.log('\nCalendario (salidas en vigor por red y día):');
const departures = (net, date, holidays) => {
  const { active } = activeSets(net.routing.calendar, date, holidays);
  let n = 0;
  for (const pattern of net.routing.patterns) {
    for (const [set, bands] of pattern.bands) {
      if (active[set]) for (let b = 2; b < bands.length; b += 4) n += bands[b];
    }
  }
  return n;
};
for (const net of nets) {
  const count = (date) => departures(net, date, graph.holidays);
  const [weekday, saturday, sunday, holiday] = [WEEKDAY, SATURDAY, SUNDAY, HOLIDAY].map(count);
  console.log(`   ${net.id}: laborable ${weekday} · sábado ${saturday} · domingo ${sunday} · festivo 8/12 ${holiday}`);
  check(weekday > saturday && saturday >= sunday * 0.95, `${net.id}: se esperaba laborable > sábado ≥ domingo`);
  check(Math.abs(holiday - sunday) <= 0.1 * sunday, `${net.id}: el festivo 8/12 debería parecerse a un domingo`);
  check(count('2029-03-07') > 0, `${net.id}: una fecha fuera de los datos debería usar el día de la semana`);
}

// Con solo la EMT (redes desactivadas) no debe salir ningún interurbano.
if (onlyEmt && has('inter')) {
  const result = planRoutes(onlyEmt, { from: place('Atocha'), to: place('Plaza de Castilla'), date: WEEKDAY, time: hm('10:00') });
  check(result.routes.length > 0 && result.routes.every((r) => r.lines.every((id) => id.startsWith('emt:'))), 'con solo la EMT sale otra red');
}

console.log(failures ? `\n${failures} comprobaciones fallidas` : '\nTodo correcto');
process.exit(failures ? 1 : 0);
