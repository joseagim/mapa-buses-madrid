// Estado en la URL (parte "#..."), para poder compartir un enlace.
//
// Formato:  #l=C1:e6194b,27:1f77d0:i,73:2ca02c:v&m=13/40.4168/-3.7038
//
//   l = líneas separadas por comas:  nombre:color[:sentido]
//         color   -> hexadecimal sin '#'
//         sentido -> 'i' solo ida, 'v' solo vuelta; si falta, ambos
//   m = vista del mapa: zoom/latitud/longitud
//
// El resto de claves son de los modos Ruta y Cerca, que las interpretan ellos
// (parseHash las devuelve tal cual en `params`):
//
//   t = modo: 'ruta' o 'cerca' (si falta, Líneas)
//   o, d = origen y destino de la ruta: latitud,longitud,nombre
//   h = hora de salida: AAAA-MM-DDTHH:MM (si falta, ahora)
//   r = cuál de las rutas está elegida (si falta, la primera)
//   c = centro de «paradas cercanas»: latitud,longitud,radio,nombre

const DIRS = new Set(['b', 'i', 'v']);

/** 'lat,lon,resto...' -> {lat, lon, rest: [..]} o null si no son coordenadas válidas. */
export function parsePoint(text) {
  if (!text) return null;
  const [lat, lon, ...rest] = text.split(',');
  const point = { lat: Number(lat), lon: Number(lon), rest };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;
  if (Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) return null;
  return point;
}

export function parseHash(hash) {
  const out = { lines: [], view: null, params: {} };
  const text = hash.replace(/^#/, '');
  if (!text) return out;
  for (const part of text.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    let value = part.slice(eq + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      continue;
    }
    if (key === 'l') {
      for (const item of value.split(',')) {
        const [name, color, dir] = item.split(':');
        if (!name) continue;
        out.lines.push({
          name,
          color: /^[0-9a-fA-F]{6}$/.test(color || '') ? '#' + color.toLowerCase() : null,
          dir: DIRS.has(dir) ? dir : 'b',
        });
      }
    } else if (key === 'm') {
      const [z, lat, lng] = value.split('/').map(Number);
      if ([z, lat, lng].every(Number.isFinite) && z >= 0 && z <= 22 && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        out.view = { zoom: z, lat, lng };
      }
    } else {
      out.params[key] = value;
    }
  }
  return out;
}

export function buildHash(lines, view, params = {}) {
  const parts = [];
  if (lines.length) {
    parts.push('l=' + lines
      .map((l) => `${encodeURIComponent(l.name)}:${l.color.slice(1)}${l.dir !== 'b' ? ':' + l.dir : ''}`)
      .join(','));
  }
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') parts.push(`${key}=${encodeURIComponent(value)}`);
  }
  if (view) {
    parts.push(`m=${view.zoom}/${view.lat.toFixed(4)}/${view.lng.toFixed(4)}`);
  }
  return parts.length ? '#' + parts.join('&') : '';
}
