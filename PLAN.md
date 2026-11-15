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

### Estado de B1 al cortarse la sesión (15/11/2026) — LEER ANTES DE SEGUIR

`scripts/build_data.py` está reescrito y commiteado como trabajo en curso: ya
procesa las tres redes (`python scripts/build_data.py`, ~1 min) y escribe el
formato nuevo (ids `emt:27` / `inter:625` / `urb-las-rozas:1`, `stops.json` con
índices de línea, `routing.json` versión 2 con calendario por bitsets de fechas
y franjas exactas para el CRTM). **La web todavía lee el formato viejo**, por
eso `data/emt` sigue commiteado en formato v0.2 y `data/inter`, `data/urb` no
están en git (se regeneran con el script). No commitear datos nuevos hasta
hacer B2/B3.

Pendiente dentro de B1 (calendario del CRTM, lo más importante):

- El GTFS del CRTM NO se puede leer al pie de la letra. (1) Muchos servicios
  tienen máscara «todos los días» y mezclan viajes de laborable, sábado y
  festivo; el tipo real va en el trip_id: tras `service_id-route_id` viene
  `_<código>_HH:MM:SS_`, con 1 = laborable, 2 = sábado, 3 = festivo (otros
  códigos, 6/7/10/11/17/33, son horarios especiales: excluirlos). (2) En los
  viajes sin código (ids tipo `9999_...-10042_1745`) cada servicio es de un día
  de la semana, pero el festivo del lunes 2/11 aparece como «todos los lunes
  durante un año» y hay servicios de un solo día (28, 29, 30 y 31/10, 1/11).
- Solución decidida: clasificar cada VIAJE en clases L, M, X, J, V laborables,
  sábado y festivo. Con código: por el código (laborables = días L-V de la
  máscara, o los cinco si no hay). Sin código: por la máscara; un único bit de
  L-V cuyo primer día es festivo (2/11, detectado por las excepciones masivas
  de calendar_dates) cuenta como festivo. Si a una línea le falta algún día
  laborable, copiar el del día laborable más cercano. Festivo: preferir los
  viajes de domingo; usar los del lunes festivo solo si no hay de domingo.
  Luego generar los bitsets por clase (festivos de otras redes los aplica el
  router con `holidays`/`detailTo`; para el CRTM `detailTo` = inicio).
- Quitar `drop_catch_all_services` (heurística anterior: borra servicio real en
  las líneas 480-499) y sus usos.
- Comprobar con un diagnóstico que ninguna línea queda con el doble de viajes
  en un día laborable que en otro.

Otros hallazgos:

- El GTFS del CRTM (versión 28/10/2026) trae en routes.txt, pero SIN viajes,
  paradas ni trazado: interurbanas 720-728, N702, N908, 635 y urbanas 1 y 2 de
  Colmenar Viejo, 3A de Getafe, SE de Valdemoro, I1 de Algete. El script las
  lista con `nodata: true`. En la web: mostrarlas en gris, no seleccionables.
  «Colmenar Viejo → Plaza de Castilla» no se puede calcular bien con estos
  datos (solo pasa la 610): avisar al usuario y probar Tres Cantos → Plaza de
  Castilla como sustituto.
- Un 10 % de los viajes del CRTM no trae horas de paso: se estiman (hecho).
- Tamaños (gzip): routing emt 132 KB, inter ~230 KB, urb ~50 KB; stops emt
  101 KB, inter 159 KB, urb 72 KB. No hace falta trocear por zonas: cargar por
  red y bajo demanda (índices al arrancar; paradas CRTM en segundo plano).
- Pruebas en el navegador: el servidor de `.claude/launch.json` (carpeta padre)
  ya no cachea. En escritorio las coordenadas de clic son píxeles de página
  / 1,28; en móvil, × 1,25. Las transiciones CSS solo avanzan al hacer captura.

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
