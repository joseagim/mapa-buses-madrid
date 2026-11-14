# Plan v0.2 — buscador de rutas y búsquedas por lugar (solo EMT)

> Fichero de trabajo temporal. Si la sesión se corta: leer esto y `git status`,
> y seguir por el primer paso sin marcar. Se borra antes del push.

## Decisiones tomadas

- **Datos de rutas: «horario comprimido en franjas»**, no `stop_times` ni horarios exactos.
  El GTFS de la EMT trae un viaje por expedición (86.635 viajes, 100 MB de `stop_times`) y
  además `frequencies.txt` con el intervalo de cada franja. Todos los viajes de un recorrido
  tienen el mismo perfil de tiempos (solo cambia la duración total), así que por cada
  recorrido (línea + sentido) se guarda: paradas, perfil de tiempos base y, por tipo de día,
  franjas `[primera salida, última salida, nº de salidas, duración]`.
  - Franja con intervalo ≤ 15 min → se espera medio intervalo (los buses urbanos no cumplen
    un horario al minuto).
  - Franja con intervalo > 15 min (búhos, líneas especiales) → se espera a la siguiente salida.
  - El mismo formato sirve para horarios puros (CRTM): un viaje suelto es una franja de 1 salida.
- **Algoritmo: RAPTOR** (por rondas = nº de buses), adaptado a franjas. Va sobrado de
  velocidad (474 recorridos, 4.700 paradas), así que se lanza varias veces vetando líneas
  para sacar alternativas de verdad.
- **Transbordos a pie**: paradas a ≤ 300 m en línea recta, 4,5 km/h, con factor de rodeo 1,25.
  Se calculan en el navegador con una rejilla (no engordan los datos y valdrán entre redes).
- **Geocodificador: Photon** (komoot, datos OSM): permite autocompletar, encuentra calles,
  portales y lugares (IFEMA, estaciones), acepta `bbox`. Uso justo: debounce, mínimo 3 letras,
  caché y cancelación. **Respaldo: CartoCiudad** (IGN, CC BY 4.0) si Photon falla; es oficial y
  bueno con calles y portales, pero no encuentra lugares («IFEMA», «Avenida de América» → nada).
  Nominatim descartado: su política prohíbe el autocompletado y limita a 1 petición/s.
- **Multi-red**: todo indexado por red (`NETWORKS` en config, `data/<red>/routing.json`).
  El motor une recorridos de todas las redes cargadas y los transbordos a pie salen de las
  coordenadas, así que los interurbanos del CRTM entrarán generando `data/crtm/`.
- **Interfaz**: tres modos — Líneas (con Paradas y Transbordos dentro) / Ruta / Cerca.

## Pasos

- [x] 1. Preprocesado: `build_data.py` genera `routing.json` (recorridos, franjas, calendario)
- [x] 2. Motor de rutas `js/router.js` (RAPTOR + a pie + alternativas) con prueba en Node
- [x] 3. Interfaz en modos Líneas / Ruta / Cerca (reorganizar panel y `app.js`)
- [x] 4. Geocodificador `js/geocode.js` y selector de lugar (parada, dirección, punto del mapa)
- [x] 5. Modo Ruta: formulario, hora de salida, 3 rutas, dibujo en el mapa
- [x] 6. Modo Cerca: radio con deslizador, paradas, líneas y pintarlas
- [x] 7. Enlace compartible (modo y origen/destino en la URL) y créditos
- [ ] 8. Verificación en navegador (trayectos reales, móvil, v0.1) y correcciones
- [ ] 9. Servidor local + resumen al usuario → esperar visto bueno
- [ ] 10. (Tras el visto bueno) README, borrar PLAN.md, push a main, tag v0.2
