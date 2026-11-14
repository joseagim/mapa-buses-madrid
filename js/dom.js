// Utilidades de DOM compartidas por todos los módulos de la interfaz.

export const $ = (selector) => document.querySelector(selector);

/** Crea un elemento: h('button', {class: 'x', onclick: fn}, 'texto', otroElemento) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'style') el.style.cssText = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) el.append(child);
  }
  return el;
}

export const isMobile = () => window.matchMedia('(max-width: 700px)').matches;

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

let toastTimer;
export function toast(message, ms = 4000) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/** 95 -> «2 min»; menos de un minuto -> «1 min». */
export function formatMinutes(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`;
}

/** 437 -> «440 m»; 1250 -> «1,3 km». */
export function formatMeters(meters) {
  if (meters < 950) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}

/** Segundos desde las 0:00 -> «18:05» (admite más de 24 h). */
export function formatClock(seconds) {
  const total = Math.round(seconds / 60);
  const hours = ((Math.floor(total / 60) % 24) + 24) % 24;
  return `${String(hours).padStart(2, '0')}:${String(((total % 60) + 60) % 60).padStart(2, '0')}`;
}
