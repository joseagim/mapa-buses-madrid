// Prueba del buscador de rutas con trayectos reales. Sin dependencias:
//
//     node tests/router.test.mjs            (comprueba y resume)
//     node tests/router.test.mjs --verbose  (enseña cada ruta tramo a tramo)
//
// Comprueba cosas de sentido común (hay rutas, los tiempos son creíbles, las
// variantes usan líneas distintas...). Sirve para revisar que todo sigue bien
// después de actualizar los datos o tocar js/router.js.

import { readFileSync } from 'node:fs';
import { buildGraph, planRoutes } from '../js/router.js';

const verbose = process.argv.includes('--verbose');
const load = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

const index = load('data/emt/index.json');
const lineName = new Map(index.lines.map((l) => [l.id, l.name]));
const stops = load('data/emt/stops.json').stops.map(([id, code, name, lat, lon, lines]) => ({ id, code, name, lat, lon, lines }));

let started = performance.now();
const graph = buildGraph([{ id: 'emt', stops, routing: load('data/emt/routing.json') }]);
console.log(`Grafo: ${graph.stops.length} paradas, ${graph.patterns.length} recorridos (${Math.round(performance.now() - started)} ms)`);

const PLACES = {
  'Cuatro Caminos': [40.4468, -3.7040],
  IFEMA: [40.4664, -3.6172],
  Callao: [40.4203, -3.7059],
  'Avenida de América': [40.4376, -3.6773],
  Atocha: [40.4087, -3.6922],
  'Plaza de Castilla': [40.4660, -3.6894],
  Moncloa: [40.4349, -3.7195],
  'Puerta del Sol': [40.4168, -3.7038],
  'Aluche': [40.3857, -3.7604],
  'Vicálvaro': [40.4044, -3.6085],
};
const place = (name) => ({ name, lat: PLACES[name][0], lon: PLACES[name][1] });

// Un miércoles laborable normal dentro del periodo del feed.
const WEEKDAY = '2026-11-18';
const SATURDAY = '2026-11-21';
const hm = (text) => { const [h, m] = text.split(':').map(Number); return h * 3600 + m * 60; };
const clock = (s) => {
  const t = Math.round(s / 60);
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const min = (s) => Math.round(s / 60);

// [origen, destino, fecha, hora, minutos mínimos y máximos creíbles para la mejor ruta]
const CASES = [
  ['Cuatro Caminos', 'IFEMA', WEEKDAY, '10:00', 40, 80],
  ['Callao', 'Avenida de América', WEEKDAY, '10:00', 15, 45],
  ['Atocha', 'Plaza de Castilla', WEEKDAY, '10:00', 25, 55],
  ['Atocha', 'Plaza de Castilla', WEEKDAY, '08:00', 25, 60],
  ['Moncloa', 'Vicálvaro', WEEKDAY, '18:00', 45, 100],
  ['Aluche', 'Puerta del Sol', SATURDAY, '12:00', 25, 60],
  ['Puerta del Sol', 'Callao', WEEKDAY, '10:00', 3, 15, 'walk'],
  ['Puerta del Sol', 'Plaza de Castilla', WEEKDAY, '03:00', 20, 80], // de madrugada: búhos
];

let failures = 0;
const check = (ok, message) => {
  if (!ok) {
    failures++;
    console.log(`   ✗ ${message}`);
  }
};

for (const [from, to, date, time, minMin, maxMin] of CASES) {
  started = performance.now();
  const result = planRoutes(graph, { from: place(from), to: place(to), date, time: hm(time) });
  const ms = performance.now() - started;
  console.log(`\n${from} → ${to} · ${date} ${time} · ${result.routes.length} rutas (${ms.toFixed(0)} ms)`);
  if (result.walk) console.log(`   a pie: ${min(result.walk.time)} min (${Math.round(result.walk.dist)} m)`);

  check(result.routes.length > 0 || result.walk, 'no hay ninguna ruta');
  result.routes.forEach((route, i) => {
    const rides = route.legs.filter((l) => l.type === 'ride');
    const summary = rides.map((l) => [l.line, ...l.altLines.map((a) => a.line)].map((id) => lineName.get(id)).join('/')).join(' → ');
    console.log(`   ${i + 1}. ${min(route.duration)} min · ${route.transfers} transb. · a pie ${min(route.walkTime)} min · espera ${min(route.waitTime)} min · ${summary}`);
    if (verbose) {
      for (const leg of route.legs) {
        if (leg.type === 'walk') {
          console.log(`        ${clock(leg.start)} a pie ${min(leg.time)} min (${Math.round(leg.dist)} m) hasta ${leg.to.name}`);
        } else {
          console.log(`        ${clock(leg.depart)} línea ${lineName.get(leg.line)}: ${leg.board.name} (${leg.board.code}) → ${leg.alight.name} (${leg.alight.code}), `
            + `${leg.stops.length - 1} paradas, ${min(leg.time)} min, espera ${min(leg.wait)} min (${leg.scheduled ? 'horario' : `cada ${min(leg.gap)} min`})`);
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
    check(ms < 500, `el cálculo tarda demasiado (${ms.toFixed(0)} ms)`);
  }
}

console.log(failures ? `\n${failures} comprobaciones fallidas` : '\nTodo correcto');
process.exit(failures ? 1 : 0);
