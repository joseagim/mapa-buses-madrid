// Selector de lugar: un campo de texto que propone paradas (al instante, con
// los datos locales) y direcciones o lugares (con el geocodificador), además
// de «mi ubicación» y «elegir en el mapa». Lo usan los modos Ruta y Cerca.
//
// Un lugar es {lat, lon, name, kind, stop?}, con kind = 'stop' | 'address' |
// 'map' | 'gps'.

import { GEOCODER } from './config.js';
import { h, debounce, toast } from './dom.js';
import { normalizeText } from './geo.js';
import { searchPlaces } from './geocode.js';

/** Paradas que coinciden con un texto (nombre o código), las mejores primero. */
export function searchStops(stops, text, max = 60) {
  const query = normalizeText(text);
  if (query.length < 2) return { matches: [], total: 0 };
  const tokens = query.split(/\s+/);
  const scored = [];
  for (const stop of stops) {
    if (!tokens.every((t) => stop.search.includes(t))) continue;
    // primero el código exacto, luego los que empiezan por el texto buscado
    const score = stop.code === query ? 0 : stop.code.startsWith(query) ? 1 : stop.nameNorm.startsWith(query) ? 2 : 3;
    scored.push([score, stop]);
  }
  scored.sort((a, b) => a[0] - b[0]
    || a[1].name.localeCompare(b[1].name, 'es')
    || a[1].code.localeCompare(b[1].code, 'es', { numeric: true }));
  return { matches: scored.slice(0, max).map(([, stop]) => stop), total: scored.length };
}

export const stopPlace = (stop) => ({
  lat: stop.lat, lon: stop.lon, name: `${stop.name} (parada ${stop.code})`, kind: 'stop', stop,
});

export const mapPlace = (lat, lon) => ({ lat, lon, name: 'Punto del mapa', kind: 'map' });

/** Pide la ubicación al navegador. Devuelve una promesa con el lugar. */
export function locatePlace() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Este navegador no permite obtener la ubicación.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, name: 'Mi ubicación', kind: 'gps' }),
      (error) => reject(new Error(error.code === 1
        ? 'No hay permiso para usar la ubicación.'
        : 'No se ha podido obtener la ubicación.')),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}

/**
 * @param {object} options
 *   label        texto accesible («Origen»)
 *   placeholder
 *   marker       letra o símbolo que se pinta a la izquierda («A», «B», «•»)
 *   stops        () => lista de paradas (con .search, .nameNorm)
 *   lineNames    (parada) => etiquetas de sus líneas (texto o elementos)
 *   near         () => {lat, lon} para dar preferencia a lo cercano
 *   onChange     (lugar | null) => void
 *   onPickOnMap  () => void   el usuario quiere tocar un punto del mapa
 */
export function createPlaceInput(options) {
  let place = null;
  let items = [];       // sugerencias visibles: [{label, detail, badge, pick}]
  let active = -1;
  let request = null;   // AbortController de la búsqueda en curso
  let ticket = 0;
  let pickFirst = false; // se pulsó Intro antes de que llegaran los resultados

  const input = h('input', {
    type: 'search', class: 'place-input', placeholder: options.placeholder,
    autocomplete: 'off', spellcheck: 'false', 'aria-label': options.label,
    enterkeyhint: 'search',
  });
  const list = h('ul', { class: 'suggest', hidden: true, role: 'listbox' });
  const locate = h('button', {
    type: 'button', class: 'icon place-locate', title: 'Usar mi ubicación', 'aria-label': `${options.label}: usar mi ubicación`,
    onclick: useLocation,
  }, h('span', { class: 'ico-locate', 'aria-hidden': 'true' }));
  const el = h('div', { class: 'place' },
    h('div', { class: 'place-row' },
      h('span', { class: `place-marker ${options.markerClass || ''}`, 'aria-hidden': 'true', text: options.marker || '' }),
      input,
      locate,
    ),
    list,
  );

  function set(next, { silent = false } = {}) {
    place = next;
    input.value = next ? next.name : '';
    el.classList.toggle('filled', Boolean(next));
    close();
    if (!silent) options.onChange(place);
  }

  /** Cambia el nombre del lugar actual (p. ej. al saber la calle de un punto del mapa). */
  function rename(target, name) {
    if (place !== target || !name) return;
    place.name = name;
    if (document.activeElement !== input) input.value = name;
  }

  async function useLocation() {
    locate.disabled = true;
    try {
      set(await locatePlace());
    } catch (error) {
      toast(error.message);
    } finally {
      locate.disabled = false;
    }
  }

  function close() {
    request?.abort();
    ticket++;
    list.hidden = true;
    list.replaceChildren();
    items = [];
    active = -1;
  }

  function render(stopItems, placeItems, status) {
    items = [...stopItems, ...placeItems];
    if (!input.value.trim()) {
      items = [
        { label: 'Mi ubicación', detail: 'Usa la posición de este dispositivo', badge: '◎', pick: useLocation },
        { label: 'Elegir en el mapa', detail: 'Toca un punto del mapa', badge: '＋', pick: () => { close(); input.blur(); options.onPickOnMap(); } },
      ];
    }
    active = -1;
    list.replaceChildren();
    const addGroup = (title, group) => {
      if (!group.length) return;
      if (title) list.append(h('li', { class: 'suggest-title', text: title }));
      for (const item of group) {
        const index = items.indexOf(item);
        list.append(h('li', { role: 'option' },
          h('button', { type: 'button', class: 'suggest-row', 'data-index': index, onclick: () => item.pick() },
            item.pin
              ? h('span', { class: 'suggest-badge' }, h('i', { class: 'ico-pin' }))
              : h('span', { class: `suggest-badge${item.code ? ' stop-code' : ''}`, text: item.badge }),
            h('span', { class: 'stop-text' },
              h('span', { class: 'stop-name', text: item.label }),
              item.detail ? h('span', { class: 'stop-lines' }, item.detail) : null,
            ),
          )));
      }
    };
    if (!input.value.trim()) {
      addGroup(null, items);
    } else {
      addGroup('Paradas', stopItems);
      addGroup('Lugares y direcciones', placeItems);
      if (status) list.append(h('li', { class: 'suggest-status', text: status }));
    }
    list.hidden = false;
  }

  function stopSuggestions(text) {
    return searchStops(options.stops(), text, 4).matches.map((stop) => ({
      label: stop.name, detail: options.lineNames(stop), badge: stop.code, code: true,
      pick: () => set(stopPlace(stop)),
    }));
  }

  async function pickPlace(found) {
    if (found.resolve) {
      try {
        Object.assign(found, await found.resolve());
        delete found.resolve;
      } catch {
        toast('No se han podido obtener las coordenadas de esa dirección.');
        return;
      }
    }
    set({ lat: found.lat, lon: found.lon, name: found.name, kind: 'address' });
  }

  const searchRemote = debounce(async (text, mine, stopItems) => {
    if (mine !== ticket) return;
    request = new AbortController();
    try {
      const found = await searchPlaces(text, { near: options.near?.(), signal: request.signal });
      if (mine !== ticket) return;
      const placeItems = found.map((p) => ({ label: p.name, detail: p.detail, pin: true, pick: () => pickPlace(p) }));
      render(stopItems, placeItems, stopItems.length + placeItems.length ? null : 'No se ha encontrado nada con ese texto.');
      if (pickFirst && items.length) items[0].pick();
    } catch {
      if (mine !== ticket) return;
      render(stopItems, [], stopItems.length ? 'El buscador de direcciones no responde.' : 'El buscador de direcciones no responde. Prueba a tocar el punto en el mapa.');
    }
  }, GEOCODER.debounceMs);

  function update() {
    const text = input.value.trim();
    request?.abort();
    pickFirst = false;
    const mine = ++ticket;
    if (!text) {
      render([], [], null);
      return;
    }
    const stopItems = stopSuggestions(text);
    if (text.length < GEOCODER.minChars) {
      render(stopItems, [], stopItems.length ? null : 'Sigue escribiendo: una parada, una calle o un lugar.');
      return;
    }
    render(stopItems, [], 'Buscando direcciones…');
    searchRemote(text, mine, stopItems);
  }

  function setActive(index) {
    active = index;
    for (const row of list.querySelectorAll('.suggest-row')) {
      row.classList.toggle('active', Number(row.dataset.index) === index);
    }
  }

  input.addEventListener('input', () => {
    if (place) {
      place = null;
      el.classList.remove('filled');
      options.onChange(null);
    }
    update();
  });
  input.addEventListener('focus', () => {
    if (place) input.select();
    else update();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
    } else if (e.key === 'Enter') {
      const item = items[active] || (input.value.trim() ? items[0] : null);
      if (item) item.pick();
      else if (input.value.trim()) pickFirst = true; // aún se está buscando
    } else if (e.key === 'Escape') {
      close();
    }
  });
  // Que al pulsar una sugerencia el campo no pierda el foco antes del clic.
  list.addEventListener('pointerdown', (e) => e.preventDefault());
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement === input) return;
      close();
      if (place) input.value = place.name;
    }, 150);
  });

  return { el, input, set, rename, get: () => place, focus: () => input.focus() };
}
