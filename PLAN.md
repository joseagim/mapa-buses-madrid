# Plan de la v0.3

Objetivo: corregir dos fallos de la v0.2 y añadir las redes del Consorcio
(interurbanos y urbanos de otros municipios) a todas las funciones.

Si la sesión se corta: leer este fichero y `git status`, y seguir por el primer
paso sin marcar. Este fichero se borra antes del push.

## A. Correcciones

- [x] **A1. Cuadro de parada que se cierra solo.** Causa: al pulsar una línea
  del popup se rehace su contenido (`setContent`) mientras el clic todavía está
  subiendo por el DOM; el botón pulsado ya no cuelga del popup, Leaflet deja de
  reconocer el clic como «dentro del popup» y lo trata como un clic en el mapa
  (que cierra el popup, pliega el panel o elige un punto). Solo pasa cuando los
  datos de la línea ya estaban cargados, por eso es intermitente. Además, al
  añadir una línea desde el modo Ruta se cambia de modo y se cierra el popup.
  Arreglo: actualizar el popup sin sustituir sus nodos, cortar la propagación
  del clic en el contenedor y no cerrarlo al cambiar de modo.
- [x] **A2. Panel móvil con tres alturas** (plegado, media pantalla, ~90 %),
  arrastrable con el dedo, con scroll interior. Al calcular una ruta sube solo
  a media pantalla.

## B. Redes del CRTM

- [ ] **B1. Preprocesado de las tres redes** (`scripts/build_data.py`):
  identificadores únicos (`emt:27`, `inter:625`, `urb-colmenar-viejo:1`),
  municipio de las urbanas, nombres legibles, horarios reales comprimidos sin
  pérdida (salidas regulares agrupadas), calendario por fechas (bitsets),
  tiempos estimados para los viajes que vienen sin horas de paso, festivos.
  Generar `data/emt`, `data/inter`, `data/urb`.
- [ ] **B2. Buscador de rutas** (`js/router.js`): formato nuevo, calendario por
  fechas y festivos, horarios exactos para el CRTM, varias redes a la vez.
  Prueba `tests/router.test.mjs` con trayectos entre redes.
- [ ] **B3. Capa de datos de la web**: carga por red y por partes (índices al
  arrancar, paradas y horarios bajo demanda), identificadores globales, URL
  compatible con los enlaces de la v0.2.
- [ ] **B4. Interfaz**: etiqueta de línea con el color de su red y el color del
  usuario aparte, municipio en las urbanas, lista agrupada por red con filtros
  y búsqueda por municipio, selector de redes visibles (que hace de leyenda),
  popups de parada, transbordos y modo Cerca con las tres redes.
- [ ] **B5. Modo Ruta con las tres redes**: redes activas, etiquetas, dibujo de
  variantes de recorrido, avisos de tiempos estimados.

## C. Legal y documentación

- [ ] **C1. Créditos** en la web («Powered by CRTM», fecha, licencia) y README:
  cómo actualizar cada red, formato de datos, licencias (código MIT, datos del
  CRTM bajo su licencia, datos de la EMT bajo sus condiciones).

## Verificación

- [ ] **V1. Navegador, escritorio y móvil**, con capturas: popup de parada,
  tres alturas del panel, rutas entre redes (Colmenar Viejo → Plaza de
  Castilla, Alcalá de Henares → Avenida de América, Móstoles → Príncipe Pío,
  Las Rozas → Moncloa), líneas 1 y 2 de Colmenar frente a las de la EMT, y
  repaso de lo de la v0.2. Peso de la carga inicial.

## Cierre (cuando el usuario dé el visto bueno)

- [ ] Repasar el README, borrar este fichero, push a `main` y tag `v0.3`.
