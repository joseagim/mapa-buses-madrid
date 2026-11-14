// Utilidades geográficas y de texto.

/** Decodifica una "encoded polyline" de Google (precisión 5) a [[lat, lon], ...]. */
export function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  const points = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < str.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lon += delta;
    }
    points.push([lat / factor, lon / factor]);
  }
  return points;
}

/** Distancia en metros entre dos puntos (haversine). */
export function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Metros por píxel en Madrid para un nivel de zoom (proyección Web Mercator). */
export function metersPerPixel(zoom, lat = 40.42) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/** Texto en minúsculas y sin tildes, para buscar. */
export function normalizeText(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Devuelve '#fff' o '#111' según qué texto se lee mejor sobre el color dado. */
export function textColorFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? '#111' : '#fff';
}

// ---------------------------------------------------------------------------
// Búsqueda de paradas por cercanía
// ---------------------------------------------------------------------------

const GRID_LAT0 = 40.42;
const GRID_KX = 111320 * Math.cos((GRID_LAT0 * Math.PI) / 180); // m por grado de longitud
const GRID_KY = 110540;                                          // m por grado de latitud

/**
 * Rejilla espacial sobre una lista de puntos {lat, lon}: permite pedir «los que
 * están a menos de R metros de aquí» sin recorrerlos todos.
 */
export class PointGrid {
  constructor(points, cellM = 300) {
    this.points = points;
    this.cell = cellM;
    this.cells = new Map();
    points.forEach((p, i) => {
      const key = this.key(Math.floor((p.lon * GRID_KX) / cellM), Math.floor((p.lat * GRID_KY) / cellM));
      let bucket = this.cells.get(key);
      if (!bucket) this.cells.set(key, (bucket = []));
      bucket.push(i);
    });
  }

  key(cx, cy) {
    return cx * 100003 + cy;
  }

  /** Devuelve [{index, point, dist}] a menos de `radiusM`, del más cercano al más lejano. */
  within(lat, lon, radiusM) {
    const cx = Math.floor((lon * GRID_KX) / this.cell);
    const cy = Math.floor((lat * GRID_KY) / this.cell);
    const reach = Math.ceil(radiusM / this.cell);
    const found = [];
    for (let gx = cx - reach; gx <= cx + reach; gx++) {
      for (let gy = cy - reach; gy <= cy + reach; gy++) {
        const bucket = this.cells.get(this.key(gx, gy));
        if (!bucket) continue;
        for (const index of bucket) {
          const point = this.points[index];
          const dist = distanceM(lat, lon, point.lat, point.lon);
          if (dist <= radiusM) found.push({ index, point, dist });
        }
      }
    }
    return found.sort((a, b) => a.dist - b.dist);
  }
}
