// Dibujo de líneas en paralelo, como en un plano de metro.
//
// Idea: cada recorrido se dibuja desplazado unos píxeles hacia la DERECHA de
// su sentido de marcha. El desplazamiento depende de cuántas líneas
// seleccionadas "anteriores" comparten esa calle en ese mismo sentido
// (su "carril"): la primera va en el carril 0, la segunda en el 1, etc.
//
//  - Dos líneas por la misma calle y en el mismo sentido -> carriles distintos.
//  - Ida y vuelta por la misma calle -> una a cada lado, nunca se pisan.
//
// El cálculo tiene tres pasos:
//   1. buildTrack():   densifica el recorrido (un punto cada ~15 m) y calcula
//                      el rumbo en cada punto.
//   2. computeLanes(): para cada punto, cuenta las líneas anteriores que pasan
//                      cerca y con el mismo rumbo -> número de carril.
//   3. offsetPath():   ya en píxeles, desplaza cada punto según su carril.

const LAT0 = 40.42;
const LON0 = -3.7;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180); // metros por grado de longitud
const KY = 110540;                                     // metros por grado de latitud
const COS_SAME_HEADING = Math.cos((40 * Math.PI) / 180);

/**
 * Densifica una polilínea [[lat, lon], ...] para que no haya tramos de más de
 * `step` metros y calcula coordenadas en metros y rumbo (vector unitario).
 */
export function buildTrack(latlngs, step = 15) {
  const lat = [];
  const lon = [];
  let prev = null;
  for (const [la, lo] of latlngs) {
    if (prev) {
      const d = Math.hypot((lo - prev[1]) * KX, (la - prev[0]) * KY);
      if (d < 0.5) continue; // punto repetido
      const parts = Math.ceil(d / step);
      for (let k = 1; k < parts; k++) {
        lat.push(prev[0] + ((la - prev[0]) * k) / parts);
        lon.push(prev[1] + ((lo - prev[1]) * k) / parts);
      }
    }
    lat.push(la);
    lon.push(lo);
    prev = [la, lo];
  }

  const n = lat.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const hx = new Float64Array(n);
  const hy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = (lon[i] - LON0) * KX;
    y[i] = (lat[i] - LAT0) * KY;
  }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const dx = x[b] - x[a];
    const dy = y[b] - y[a];
    const len = Math.hypot(dx, dy) || 1;
    hx[i] = dx / len;
    hy[i] = dy / len;
  }
  return { n, lat, lon, x, y, hx, hy };
}

/**
 * Calcula el carril de cada punto de cada recorrido.
 *
 * @param {Array<{order:number, track:object}>} items  recorridos a dibujar;
 *        `order` es la posición de la línea en la lista de seleccionadas
 *        (ida y vuelta de una misma línea comparten `order`).
 * @param {number} radius  distancia (m) a la que dos recorridos "comparten calle".
 * @returns {Uint8Array[]} un array de carriles por recorrido.
 */
export function computeLanes(items, radius) {
  // Rejilla espacial: celda -> puntos (recorrido, índice) que caen en ella.
  const cell = radius;
  const grid = new Map();
  const keyOf = (cx, cy) => (cx + 20000) * 40000 + (cy + 20000);
  items.forEach(({ track }, ti) => {
    for (let i = 0; i < track.n; i++) {
      const key = keyOf(Math.floor(track.x[i] / cell), Math.floor(track.y[i] / cell));
      let bucket = grid.get(key);
      if (!bucket) grid.set(key, (bucket = []));
      bucket.push(ti * 65536 + i);
    }
  });

  const r2 = radius * radius;
  return items.map(({ order, track }) => {
    const lanes = new Uint8Array(track.n);
    if (order === 0) return lanes; // la primera línea siempre va en el carril 0
    for (let i = 0; i < track.n; i++) {
      const px = track.x[i];
      const py = track.y[i];
      const cx = Math.floor(px / cell);
      const cy = Math.floor(py / cell);
      const found = new Set();
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const bucket = grid.get(keyOf(gx, gy));
          if (!bucket) continue;
          for (const packed of bucket) {
            const other = items[Math.floor(packed / 65536)];
            if (other.order >= order || found.has(other.order)) continue;
            const j = packed % 65536;
            const t = other.track;
            const dx = t.x[j] - px;
            const dy = t.y[j] - py;
            if (dx * dx + dy * dy > r2) continue;
            if (t.hx[j] * track.hx[i] + t.hy[j] * track.hy[i] < COS_SAME_HEADING) continue;
            found.add(other.order);
          }
        }
      }
      lanes[i] = found.size;
    }
    return removeShortRuns(lanes, 5);
  });
}

/** Elimina cambios de carril muy cortos (ruido en cruces y esquinas). */
function removeShortRuns(lanes, minRun) {
  const n = lanes.length;
  let start = 0;
  let prevValue = -1;
  while (start < n) {
    let end = start;
    while (end < n && lanes[end] === lanes[start]) end++;
    if (end - start < minRun) {
      // tramo corto: toma el valor del tramo anterior (o del siguiente si es el primero)
      const fill = prevValue >= 0 ? prevValue : end < n ? lanes[end] : lanes[start];
      lanes.fill(fill, start, end);
    } else {
      prevValue = lanes[start];
    }
    start = end;
  }
  return lanes;
}

/**
 * Convierte carriles en desplazamientos en píxeles, suavizando las transiciones
 * para que el cambio de carril sea una pequeña diagonal y no un escalón.
 */
export function lanesToOffsets(lanes, spacing) {
  const n = lanes.length;
  const out = new Float32Array(n);
  const win = 2;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, i - win); k <= Math.min(n - 1, i + win); k++) {
      sum += lanes[k];
      count++;
    }
    out[i] = (sum / count + 0.5) * spacing;
  }
  return out;
}

/**
 * Desplaza una polilínea en píxeles `offs[i]` px a la derecha del sentido de marcha.
 * Antes la simplifica (para que las esquinas queden limpias) y después elimina
 * los tramos que quedan "del revés" en el interior de curvas cerradas.
 *
 * @returns {Array<[number, number]>} puntos desplazados
 */
export function offsetPath(xs, ys, offs, tolerance = 0.6) {
  const n = xs.length;
  if (n < 2) return [];

  // 1) Douglas-Peucker en 3D (x, y, desplazamiento): así se conservan también
  //    los puntos donde cambia el carril.
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop();
    const dx = xs[b] - xs[a];
    const dy = ys[b] - ys[a];
    const dz = offs[b] - offs[a];
    const seg2 = dx * dx + dy * dy + dz * dz;
    let worst = -1;
    let worstI = -1;
    for (let i = a + 1; i < b; i++) {
      const px = xs[i] - xs[a];
      const py = ys[i] - ys[a];
      const pz = offs[i] - offs[a];
      let d2;
      if (seg2 === 0) {
        d2 = px * px + py * py + pz * pz;
      } else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / seg2));
        d2 = (px - t * dx) ** 2 + (py - t * dy) ** 2 + (pz - t * dz) ** 2;
      }
      if (d2 > worst) {
        worst = d2;
        worstI = i;
      }
    }
    if (worst > tol2) {
      keep[worstI] = 1;
      stack.push([a, worstI], [worstI, b]);
    }
  }
  const px = [];
  const py = [];
  const po = [];
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const m = px.length;
    if (m && Math.abs(xs[i] - px[m - 1]) < 1e-6 && Math.abs(ys[i] - py[m - 1]) < 1e-6) continue;
    px.push(xs[i]);
    py.push(ys[i]);
    po.push(offs[i]);
  }
  const m = px.length;
  if (m < 2) return [];

  // 2) Desplazamiento con unión "a inglete" en cada vértice.
  //    En píxeles el eje Y crece hacia abajo, así que la normal a la derecha
  //    del vector (dx, dy) es (-dy, dx).
  const qx = new Float64Array(m);
  const qy = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let n1x = 0, n1y = 0, n2x = 0, n2y = 0;
    let has1 = false, has2 = false;
    if (i > 0) {
      const dx = px[i] - px[i - 1];
      const dy = py[i] - py[i - 1];
      const len = Math.hypot(dx, dy);
      n1x = -dy / len; n1y = dx / len; has1 = true;
    }
    if (i < m - 1) {
      const dx = px[i + 1] - px[i];
      const dy = py[i + 1] - py[i];
      const len = Math.hypot(dx, dy);
      n2x = -dy / len; n2y = dx / len; has2 = true;
    }
    let mx, my;
    if (!has1) { mx = n2x; my = n2y; }
    else if (!has2) { mx = n1x; my = n1y; }
    else {
      const k = 1 + n1x * n2x + n1y * n2y;   // 1 + cos(ángulo de giro)
      const sx = n1x + n2x;
      const sy = n1y + n2y;
      if (k >= 0.5) { mx = sx / k; my = sy / k; }       // inglete normal
      else {
        const len = Math.hypot(sx, sy);
        if (len > 1e-3) { mx = (sx / len) * 2; my = (sy / len) * 2; } // giro muy cerrado: se recorta
        else { mx = n1x; my = n1y; }                                 // cambio de sentido
      }
    }
    qx[i] = px[i] + mx * po[i];
    qy[i] = py[i] + my * po[i];
  }

  // 3) Quita los tramos invertidos (el desplazado va en sentido contrario al original).
  const out = [];
  let i = 0;
  const inverted = (s) =>
    (qx[s + 1] - qx[s]) * (px[s + 1] - px[s]) + (qy[s + 1] - qy[s]) * (py[s + 1] - py[s]) < 0;
  while (i < m) {
    if (i < m - 1 && inverted(i)) {
      let j = i;
      while (j < m - 1 && inverted(j)) j++;
      out.push([(qx[i] + qx[j]) / 2, (qy[i] + qy[j]) / 2]);
      i = j + 1;
    } else {
      out.push([qx[i], qy[i]]);
      i++;
    }
  }
  return out;
}
