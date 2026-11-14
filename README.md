# Mapa de buses de Madrid

Mapa interactivo **no oficial** de las líneas de autobús urbano de la EMT de Madrid.

En el plano del metro se ve de un vistazo cómo se conectan las líneas, pero con más de 200 líneas de autobús eso es imposible. Esta web te deja **elegir unas cuantas líneas, verlas pintadas sobre el mapa por sus calles reales y descubrir dónde se cruzan** para hacer transbordo.

![Captura de la web con las líneas C1, C2, 27, 73 y 14](docs/captura.jpg)

<p align="center"><img src="docs/captura-movil.jpg" alt="Captura en móvil" width="280"></p>

> [**Powered by EMT de Madrid**](https://www.emtmadrid.es). Datos procesados a partir del GTFS oficial de la EMT (actualizado el 13/11/2026), sujetos a sus [condiciones de uso](https://mobilitylabs.emtmadrid.es/sip/terms-of-use). Esta web **no es una aplicación oficial de la EMT**.

## Qué hace

- **Mapa a pantalla completa** (Leaflet + OpenStreetMap, sin API keys).
- **Panel de líneas** con buscador por número o nombre (`C1`, `27`, `Circular`…), selección múltiple y un color por línea que puedes cambiar.
- Cada línea se dibuja **por sus calles reales**, con sus paradas. Puedes ver la ida, la vuelta o ambas.
- Si varias líneas comparten calle **se dibujan en paralelo**, como en un plano de metro, en vez de taparse.
- **Paradas**: aparecen al acercar el zoom. Al pulsar una ves su nombre, su código y las líneas que pasan, con un botón para seleccionarlas todas.
- **Transbordos**: con dos o más líneas seleccionadas se resaltan las paradas compartidas y las parejas de paradas de líneas distintas a menos de 250 m. La pestaña «Transbordos» las lista por parejas de líneas.
- **Buscador de paradas** por nombre o código.
- **Enlace compartible**: las líneas, sus colores y la vista del mapa se guardan en la URL.
- Funciona en **móvil** (el panel pasa a ser una hoja inferior plegable).

## Ejecutarlo en local

Es una web estática: no hay que instalar ni compilar nada, solo servir la carpeta con cualquier servidor web (abrir `index.html` con doble clic no funciona, porque el navegador no deja cargar los datos desde `file://`).

```bash
git clone https://github.com/joseagim/mapa-buses-madrid.git
```

```bash
cd mapa-buses-madrid
```

```bash
python -m http.server 8000
```

Y abre <http://localhost:8000>. Para probar algo rápido: <http://localhost:8000/#l=C1,C2,27,73>.

## Actualizar los datos

Los datos que usa la web están en `data/emt/` y se generan a partir del GTFS oficial con un script de Python (solo librería estándar, Python 3.9 o superior).

1. Descarga el GTFS de la EMT desde el [portal de datos abiertos del Ayuntamiento de Madrid](https://datos.madrid.es) (busca «EMT GTFS»).
2. Guárdalo como `data/raw/gtfs_emt.zip`. Esa carpeta está en `.gitignore`: el ZIP original **no** se sube al repositorio.
3. Ejecuta el script desde la raíz del repo:

   ```bash
   python scripts/build_data.py
   ```

4. Revisa el resumen que imprime (número de líneas y paradas, avisos) y prueba la web en local.
5. Sube los cambios de `data/emt/` con un commit. La fecha que se muestra en la web se actualiza sola; acuérdate de cambiarla también en la cita de este README.

Tarda unos 15 segundos. Opciones útiles (`python scripts/build_data.py --help`):

| Opción | Para qué sirve |
| --- | --- |
| `--input RUTA` | Usar otro ZIP en vez de `data/raw/gtfs_emt.zip` |
| `--output CARPETA` | Escribir en otra carpeta en vez de `data/emt` |
| `--tolerance METROS` | Simplificación de la geometría (por defecto 2 m) |
| `--date AAAA-MM-DD` | Fecha de actualización del GTFS (por defecto, la de los ficheros del ZIP) |

### Formato de los datos generados

```
data/emt/
├── index.json        metadatos del feed y lista de líneas
├── stops.json        todas las paradas, cada una con las líneas que pasan
└── lines/<id>.json   un fichero por línea (se carga solo al seleccionarla)
```

- **`index.json`** → `feed.date` (fecha del GTFS) y `lines`: `id`, `name` (número), `long` (nombre largo) y, por sentido, cabecera y número de paradas.
- **`stops.json`** → cada parada es `[id, código, nombre, lat, lon, [ids de línea]]`.
- **`lines/<id>.json`** → por cada sentido (`dir` 0 = ida, 1 = vuelta): `shape` (geometría simplificada, en formato [*encoded polyline*](https://developers.google.com/maps/documentation/utilities/polylinealgorithm) de precisión 5), `stops` (paradas en orden), `dist` (metros acumulados) y `time` (segundos acumulados desde la primera parada).

Los campos `dist` y `time` todavía no se usan en la web: están ahí para poder añadir más adelante un **buscador de rutas A→B**. Y como el script y la web trabajan con «una carpeta por red», añadir los **interurbanos del CRTM** como otra capa sería generar `data/crtm/` con `--input`, `--output`, `--network-id` y `--network-name`, y registrar la red en `js/config.js`.

## Desplegarlo en GitHub Pages

No hace falta ningún paso de compilación:

1. En GitHub, entra en **Settings → Pages**.
2. En *Build and deployment → Source* elige **Deploy from a branch**.
3. Selecciona la rama **`main`** y la carpeta **`/ (root)`**, y pulsa **Save**.
4. En uno o dos minutos la web estará en `https://<tu-usuario>.github.io/mapa-buses-madrid/`.

Todas las rutas del proyecto son relativas, así que funciona igual en una subcarpeta.

## Estructura del proyecto

```
index.html            página única
css/style.css         estilos
js/app.js             lógica principal: datos, mapa y panel
js/offset.js          dibujo de líneas en paralelo
js/transfers.js       cálculo de transbordos
js/urlstate.js        estado en la URL
js/geo.js             utilidades (polilíneas, distancias, texto)
js/config.js          configuración (colores, zooms, red)
scripts/build_data.py preprocesado del GTFS
data/emt/             datos procesados (sí se suben al repo)
data/raw/             GTFS original (no se sube)
```

Es JavaScript sin dependencias ni *bundler* (módulos ES). Leaflet se carga desde un CDN.

### Cómo se dibujan las líneas en paralelo

Cada recorrido se desplaza unos píxeles hacia la **derecha de su sentido de marcha**. Cuánto se desplaza depende de cuántas de las líneas seleccionadas antes pasan por esa misma calle y en ese mismo sentido (su «carril»). Así, dos líneas que comparten calle van en carriles contiguos, y la ida y la vuelta quedan una a cada lado, como el tráfico real. Está explicado paso a paso en los comentarios de `js/offset.js`.

## Limitaciones conocidas

- La distancia de los transbordos es **en línea recta**, no el recorrido real a pie.
- No se tienen en cuenta horarios ni frecuencias: que dos líneas compartan parada no significa que estén funcionando a la vez (por ejemplo, una diurna y una nocturna).
- En el mapa no se indica con flechas el sentido de cada recorrido (se puede filtrar por ida o vuelta en el panel).
- Con muchas líneas por la misma calle, el «haz» de líneas en paralelo se hace ancho.
- Si una línea tiene variantes de recorrido, se dibuja solo la más frecuente (en el GTFS actual ninguna las tiene).
- El mapa base usa los servidores públicos de teselas de OpenStreetMap, pensados para un uso moderado. Si la web tuviera mucho tráfico habría que cambiar de proveedor.

Ideas para más adelante: buscador de rutas A→B, capa de interurbanos del CRTM, flechas de sentido.

## Datos y créditos

- **Datos de transporte**: [Powered by EMT de Madrid](https://www.emtmadrid.es). Son datos procesados a partir del GTFS oficial de la Empresa Municipal de Transportes de Madrid (versión del 13/11/2026), publicados en el portal de datos abiertos del Ayuntamiento de Madrid y sujetos a sus [condiciones de uso](https://mobilitylabs.emtmadrid.es/sip/terms-of-use). El procesado (simplificación de geometrías, índice de paradas) es de este proyecto, y cualquier error que haya introducido también.
- **Mapa base**: © [colaboradores de OpenStreetMap](https://www.openstreetmap.org/copyright).
- **Librería de mapas**: [Leaflet](https://leafletjs.com).

Este proyecto es personal, sin ánimo de lucro, y **no está afiliado a la EMT ni respaldado por ella**. No usa sus logotipos. Para información oficial y en tiempo real, usa los canales de la EMT.

## Desarrollado con Claude Fable 5.2

Este proyecto se ha desarrollado con **Claude Fable 5.2**, el modelo de Anthropic, usando [Claude Code](https://claude.com/claude-code). A partir de una descripción de lo que quería (funcionalidades, restricciones técnicas y requisitos legales), el modelo planificó el trabajo, escribió el script de preprocesado y la web, la probó en un navegador con capturas de pantalla y fue corrigiendo los fallos. Yo he revisado el resultado y decidido qué se publica.

## Licencia

El código se publica bajo licencia [MIT](LICENSE). Los datos de `data/emt/` derivan del GTFS de la EMT y se rigen por sus condiciones de uso, enlazadas arriba.
