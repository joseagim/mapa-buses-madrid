// Geocodificación: de un texto («Gran Vía 32», «IFEMA») a coordenadas, y al
// revés. Sin backend y sin claves.
//
//  - Principal: Photon (https://photon.komoot.io), de komoot, con datos de
//    OpenStreetMap. Está pensado para buscar mientras se escribe y encuentra
//    calles, portales y lugares (estaciones, hospitales, IFEMA...). Es un
//    servidor público de «uso justo»: aquí se le pregunta con pausa entre
//    teclas, a partir de 3 letras, con caché y cancelando lo que ya no hace falta.
//  - Respaldo: CartoCiudad (https://www.cartociudad.es), del Instituto
//    Geográfico Nacional (CC BY 4.0). Solo se usa si Photon falla. Es oficial
//    y muy bueno con calles y portales, pero no conoce lugares por su nombre.
//  - Nominatim (OpenStreetMap) se descartó: su política de uso prohíbe el
//    autocompletado.
//
// Todas las búsquedas se limitan a la Comunidad de Madrid.

import { GEOCODER } from './config.js';
import { normalizeText } from './geo.js';

const PHOTON = 'https://photon.komoot.io';
const CARTOCIUDAD = 'https://www.cartociudad.es/geocoder/api/geocoder';
const REGION = 'Comunidad de Madrid';
const TIMEOUT_MS = 6000;

const cache = new Map(); // texto normalizado -> resultados

/** fetch con límite de tiempo; `signal` permite cancelarlo desde fuera. */
async function getJson(url, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, TIMEOUT_MS);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

const inRegion = (lat, lon) => {
  const [west, south, east, north] = GEOCODER.bbox;
  return lon >= west && lon <= east && lat >= south && lat <= north;
};

/** «CALLE BRAVO MURILLO» -> «Calle Bravo Murillo» */
function titleCase(text) {
  return text.toLowerCase().replace(/(^|[\s(\-/])(\p{L})/gu, (m, sep, letter) => sep + letter.toUpperCase());
}

// ---------------------------------------------------------------------------
// Photon
// ---------------------------------------------------------------------------

function photonPlace(feature) {
  const p = feature.properties;
  const [lon, lat] = feature.geometry.coordinates;
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const name = p.name || street;
  if (!name) return null;
  const town = p.city || p.town || p.village || p.county;
  const detail = [p.name && street !== p.name ? street : null, p.district, town]
    .filter((part, i, all) => part && part !== name && all.indexOf(part) === i);
  return { name, detail: detail.join(', '), lat, lon, kind: 'address', source: 'photon', isAddress: !p.name };
}

async function searchPhoton(text, near, signal) {
  const params = new URLSearchParams({ q: text, limit: String(GEOCODER.limit + 4), bbox: GEOCODER.bbox.join(',') });
  if (near) {
    params.set('lat', near.lat.toFixed(3));
    params.set('lon', near.lon.toFixed(3));
  }
  const json = await getJson(`${PHOTON}/api/?${params}`, signal);
  const places = [];
  for (const feature of json.features || []) {
    const state = feature.properties.state;
    if (state && state !== REGION) continue; // el bbox coge un poco de las provincias vecinas
    const place = photonPlace(feature);
    if (!place) continue;
    // Photon devuelve varias veces lo mismo (cada andén o boca de metro)
    const repeated = places.some((other) => normalizeText(other.name) === normalizeText(place.name)
      && Math.abs(other.lat - place.lat) < 0.003 && Math.abs(other.lon - place.lon) < 0.004);
    if (!repeated) places.push(place);
  }
  // Si el texto lleva número («Gran Vía 32») se busca un portal: van primero
  // las direcciones y después los comercios que hay en ellas.
  if (/\d/.test(text)) places.sort((a, b) => Number(b.isAddress) - Number(a.isAddress));
  return places.slice(0, GEOCODER.limit);
}

async function reversePhoton(lat, lon, signal) {
  const json = await getJson(`${PHOTON}/reverse?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`, signal);
  const feature = json.features?.[0];
  if (!feature) return null;
  const p = feature.properties;
  // Para un punto del mapa orienta más la calle que el comercio más cercano.
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  return street || p.name || null;
}

// ---------------------------------------------------------------------------
// CartoCiudad (respaldo)
// ---------------------------------------------------------------------------

async function searchCartoCiudad(text, signal) {
  const params = new URLSearchParams({ q: text, limit: String(GEOCODER.limit), comunidad_autonoma_filter: REGION });
  const json = await getJson(`${CARTOCIUDAD}/candidates?${params}`, signal);
  return (json || []).map((item) => {
    const [street, ...rest] = item.address.split(',');
    const place = {
      name: titleCase(street.trim()),
      detail: titleCase(rest.join(',').trim() || item.muni || ''),
      lat: item.lat,
      lon: item.lng,
      kind: 'address',
      source: 'cartociudad',
    };
    if (!item.lat && !item.lng) {
      // Las calles llegan sin coordenadas: se piden al elegirlas.
      place.resolve = async () => {
        const query = new URLSearchParams({ q: item.address, type: item.type, id: item.id });
        const found = await getJson(`${CARTOCIUDAD}/find?${query}`);
        if (!found?.lat) throw new Error('sin coordenadas');
        return { lat: found.lat, lon: found.lng };
      };
    }
    return place;
  });
}

async function reverseCartoCiudad(lat, lon, signal) {
  const json = await getJson(`${CARTOCIUDAD}/reverseGeocode?lon=${lon.toFixed(5)}&lat=${lat.toFixed(5)}`, signal);
  if (!json?.address) return null;
  const via = [json.tip_via, json.address].filter(Boolean).join(' ');
  return titleCase(json.portalNumber ? `${via} ${json.portalNumber}` : via);
}

// ---------------------------------------------------------------------------
// API del módulo
// ---------------------------------------------------------------------------

/**
 * Busca lugares y direcciones. Devuelve [{name, detail, lat, lon, kind, source, resolve?}].
 * `near` ({lat, lon}) da preferencia a lo que esté cerca de ese punto.
 * Lanza un error si no responde ningún servicio.
 */
export async function searchPlaces(text, { near = null, signal = null } = {}) {
  const key = normalizeText(text);
  if (key.length < GEOCODER.minChars) return [];
  if (cache.has(key)) return cache.get(key);
  let places;
  try {
    places = await searchPhoton(text, near, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    places = await searchCartoCiudad(text, signal);
  }
  places = places.filter((place) => place.resolve || inRegion(place.lat, place.lon));
  cache.set(key, places);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return places;
}

/** Nombre aproximado de un punto del mapa, o null si no se puede saber. */
export async function reverseGeocode(lat, lon, { signal = null } = {}) {
  try {
    return await reversePhoton(lat, lon, signal);
  } catch (error) {
    if (signal?.aborted) return null;
    try {
      return await reverseCartoCiudad(lat, lon, signal);
    } catch {
      return null;
    }
  }
}
