// Cálculo de puntos de transbordo entre las líneas seleccionadas.
//
// Para cada pareja de líneas (A, B) se buscan:
//   - paradas compartidas: la misma parada está en el recorrido de A y de B;
//   - paradas cercanas: una parada de A y otra de B a menos de `maxDist`
//     metros en línea recta.
//
// Para no llenar el mapa de avisos redundantes, las paradas cercanas se filtran:
//   - se descartan las que ya tienen una parada compartida (de esa pareja de
//     líneas) a menos de `maxDist`: es mejor transbordar allí;
//   - cada parada aparece como mucho en una pareja (la más corta).

import { distanceM } from './geo.js';

/**
 * @param {Array<{id:string, stops:Array}>} lines  líneas con sus paradas
 *        ({id, lat, lon, ...}) en orden de recorrido y sin repetir.
 * @param {number} maxDist  distancia máxima a pie, en metros.
 * @returns {Array<{a:string, b:string, shared:Array, near:Array}>}
 */
export function computeTransfers(lines, maxDist) {
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const A = lines[i];
      const B = lines[j];
      const idsB = new Set(B.stops.map((s) => s.id));
      const shared = A.stops.filter((s) => idsB.has(s.id));
      const sharedIds = new Set(shared.map((s) => s.id));

      const farFromShared = (s) =>
        !sharedIds.has(s.id)
        && !shared.some((sh) => distanceM(s.lat, s.lon, sh.lat, sh.lon) <= maxDist);
      const onlyA = A.stops.filter(farFromShared);
      const onlyB = B.stops.filter(farFromShared);

      const candidates = [];
      for (const a of onlyA) {
        for (const b of onlyB) {
          // descarte rápido antes del cálculo exacto (0,003° de latitud ≈ 330 m)
          if (Math.abs(a.lat - b.lat) > 0.003 || Math.abs(a.lon - b.lon) > 0.004) continue;
          const dist = distanceM(a.lat, a.lon, b.lat, b.lon);
          if (dist <= maxDist) candidates.push({ a, b, dist });
        }
      }
      candidates.sort((p, q) => p.dist - q.dist);
      const used = new Set();
      const near = [];
      for (const c of candidates) {
        if (used.has('a' + c.a.id) || used.has('b' + c.b.id)) continue;
        used.add('a' + c.a.id);
        used.add('b' + c.b.id);
        near.push(c);
      }
      // orden: según se recorren en la línea A
      const posA = new Map(A.stops.map((s, k) => [s.id, k]));
      near.sort((p, q) => posA.get(p.a.id) - posA.get(q.a.id));

      result.push({ a: A.id, b: B.id, shared, near });
    }
  }
  return result;
}
