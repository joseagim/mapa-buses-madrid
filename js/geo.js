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
