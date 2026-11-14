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
