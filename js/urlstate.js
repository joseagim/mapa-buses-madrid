// Estado en la URL (parte "#..."), para poder compartir un enlace.
//
// Formato:  #l=C1:e6194b,27:1f77d0:i,73:2ca02c:v&m=13/40.4168/-3.7038
//
//   l = líneas separadas por comas:  nombre:color[:sentido]
//         color   -> hexadecimal sin '#'
//         sentido -> 'i' solo ida, 'v' solo vuelta; si falta, ambos
//   m = vista del mapa: zoom/latitud/longitud

const DIRS = new Set(['b', 'i', 'v']);

export function parseHash(hash) {
  const out = { lines: [], view: null };
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
    }
  }
  return out;
}

export function buildHash(lines, view) {
  const parts = [];
  if (lines.length) {
    parts.push('l=' + lines
      .map((l) => `${encodeURIComponent(l.name)}:${l.color.slice(1)}${l.dir !== 'b' ? ':' + l.dir : ''}`)
      .join(','));
  }
  if (view) {
    parts.push(`m=${view.zoom}/${view.lat.toFixed(4)}/${view.lng.toFixed(4)}`);
  }
  return parts.length ? '#' + parts.join('&') : '';
}
