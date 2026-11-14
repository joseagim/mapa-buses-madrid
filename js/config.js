// Configuración general de la web.

// Red de transporte que se muestra. Para añadir otra capa (por ejemplo los
// interurbanos del CRTM) bastaría con generar sus datos con
// scripts/build_data.py en otra carpeta y añadir aquí otra entrada.
export const NETWORK = {
  id: 'emt',
  name: 'EMT Madrid',
  path: 'data/emt',
};

// Vista inicial: Puerta del Sol.
export const HOME = { center: [40.4168, -3.7038], zoom: 13 };

// Colores por defecto de las líneas: distintos entre sí y con buen contraste
// sobre el mapa base claro. Se asigna el primero que no esté en uso.
export const PALETTE = [
  '#e6194b', // rojo
  '#1f77d0', // azul
  '#2ca02c', // verde
  '#f58231', // naranja
  '#911eb4', // morado
  '#00a3a3', // turquesa
  '#f032e6', // magenta
  '#8c564b', // marrón
  '#000075', // azul marino
  '#b8a100', // mostaza
  '#800000', // granate
  '#3d9970', // verde mar
  '#ff6f91', // rosa
  '#5a5a5a', // gris
];

// Niveles de zoom a partir de los cuales se muestra cada cosa.
export const ZOOM = {
  transfers: 12,  // puntos de transbordo
  lineStops: 13,  // paradas de las líneas seleccionadas
  allStops: 15,   // el resto de paradas de la red
  stopFocus: 17,  // zoom al ir a una parada desde el buscador
};

// Distancia máxima (en línea recta) entre dos paradas para proponer un transbordo a pie.
export const TRANSFER_RADIUS_M = 250;

// Líneas del botón de ejemplo.
export const EXAMPLE_LINES = ['C1', 'C2', '27', '73'];

// ---------------------------------------------------------------------------
// Buscador de rutas
// ---------------------------------------------------------------------------

// Redes que entran en el cálculo de rutas. Cada una aporta su stops.json y su
// routing.json; los transbordos a pie entre redes salen solos de las
// coordenadas de las paradas. Para sumar los interurbanos del CRTM bastará
// con generar data/crtm/ y añadir aquí { id: 'crtm', name: ..., path: 'data/crtm' }.
export const NETWORKS = [NETWORK];

export const ROUTING = {
  walkSpeedKmh: 4.5,      // velocidad a pie
  walkDetour: 1.25,       // la distancia real andando ≈ línea recta × este factor
  transferMaxM: 300,      // transbordo a pie: distancia máxima (línea recta) entre paradas
  accessMaxM: 800,        // paradas candidatas alrededor del origen y del destino
  accessFallbackM: 1500,  // ...y hasta dónde se amplía si no hay ninguna
  maxRides: 4,            // como mucho 4 autobuses (3 transbordos)
  transferSlackS: 60,     // margen para cambiar de autobús
  walkReluctance: 1.3,    // al buscar, andar «cuesta» un 30 % más que ir en bus
  transferPenaltyS: 300,  // al ordenar rutas, cada transbordo pesa como 5 min
  maxRoutes: 3,           // rutas que se enseñan
  walkOnlyMaxM: 1800,     // se ofrece «ir andando» hasta esta distancia en línea recta
};

// Paradas cercanas: radio (m) del deslizador.
export const NEARBY = { min: 100, max: 1000, step: 50, initial: 300 };

// Geocodificación limitada a la Comunidad de Madrid: [oeste, sur, este, norte].
export const GEOCODER = {
  bbox: [-4.58, 39.88, -3.05, 41.17],
  minChars: 3,
  debounceMs: 400,
  limit: 6,
};
