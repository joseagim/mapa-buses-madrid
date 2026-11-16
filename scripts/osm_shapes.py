"""Reconstrucción de recorridos con datos de OpenStreetMap.

Lo usa scripts/build_data.py para las líneas cuyo GTFS no trae recorrido. Hay
tres métodos, de mejor a peor:

    'osm'       una relación route=bus de OpenStreetMap que coincide con la
                línea: de ella salen el trazado y, si el GTFS tampoco trae los
                viajes, también las paradas;
    'routed'    cálculo de ruta por la red viaria de OpenStreetMap entre cada
                par de paradas consecutivas, respetando los sentidos de
                circulación (se hace aquí, en local);
    'straight'  líneas rectas entre paradas.

Los datos se piden a la API Overpass (una consulta por red para las
relaciones y una por zona para las calles) y se guardan en data/raw/osm/, que
no se sube al repositorio. Mientras exista esa caché no se vuelve a descargar
nada: bórrala (o usa --refresh-osm) para traer datos nuevos.

Los datos de OpenStreetMap son © sus colaboradores y están bajo licencia ODbL:
los recorridos reconstruidos con ellos son una obra derivada bajo esa licencia.

Solo usa la librería estándar de Python.
"""

import hashlib
import heapq
import json
import math
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

OVERPASS_SERVERS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
USER_AGENT = "gtfs-preprocess-script/0.3"

# Una parada de OpenStreetMap es la misma que una del GTFS si está a menos de...
STOP_MATCH_M = 50
# Dos tramos de una relación se consideran unidos si sus extremos distan menos de...
JOIN_M = 30


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------

def meters(a, b):
    """Distancia aproximada en metros entre dos puntos (lat, lon) cercanos."""
    kx = 111320.0 * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((a[1] - b[1]) * kx, (a[0] - b[0]) * 110540.0)


def plain(text):
    """Texto en minúsculas y sin tildes."""
    text = unicodedata.normalize("NFD", text or "")
    return "".join(c for c in text if unicodedata.category(c) != "Mn").lower()


def path_length(points):
    return sum(meters(a, b) for a, b in zip(points, points[1:]))


def distance_to_path(point, path):
    """Distancia (m) de un punto a una polilínea."""
    best = float("inf")
    kx = 111320.0 * math.cos(math.radians(point[0]))
    px, py = point[1] * kx, point[0] * 110540.0
    for a, b in zip(path, path[1:]):
        ax, ay = a[1] * kx, a[0] * 110540.0
        bx, by = b[1] * kx, b[0] * 110540.0
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
        best = min(best, math.hypot(px - ax - t * dx, py - ay - t * dy))
    return best


# ---------------------------------------------------------------------------
# Descarga (con caché)
# ---------------------------------------------------------------------------

class Overpass:
    """Consultas a la API Overpass guardadas en una carpeta de caché."""

    def __init__(self, cache_dir, refresh=False, offline=False):
        self.cache_dir = Path(cache_dir)
        self.refresh = refresh
        self.offline = offline
        self.downloaded = 0
        self.stale = []        # cachés antiguas usadas porque la descarga ha fallado

    def query(self, name, text, replaces_older=False):
        """Resultado (JSON) de una consulta. `name` da nombre al fichero de caché.

        `replaces_older`: las descargas anteriores con ese nombre son versiones
        viejas de lo mismo (se borran al llegar una nueva, y sirven de respaldo
        si Overpass no responde)."""
        digest = hashlib.sha1(text.encode()).hexdigest()[:10]
        path = self.cache_dir / f"{name}_{digest}.json"
        if path.exists() and not self.refresh:
            return json.loads(path.read_text(encoding="utf-8"))
        if self.offline:
            return None
        data = None
        for attempt, url in enumerate(OVERPASS_SERVERS):
            try:
                request = urllib.request.Request(
                    url, data=urllib.parse.urlencode({"data": text}).encode(),
                    headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(request, timeout=150) as response:
                    data = json.load(response)
                break
            except Exception as error:      # red caída, servidor saturado...
                print(f"    Overpass ({urllib.parse.urlsplit(url).netloc}): {str(error)[:80]}", file=sys.stderr)
                time.sleep(3 + 2 * attempt)
        if data is None:
            # Overpass no responde: vale la última descarga de esta consulta,
            # aunque fuera para otra lista de líneas (mejor eso que nada).
            older = sorted(self.cache_dir.glob(f"{name}_*.json"), key=lambda f: f.stat().st_mtime)
            if older and replaces_older:
                self.stale.append(older[-1].name)
                return json.loads(older[-1].read_text(encoding="utf-8"))
            return None
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        # Las descargas anteriores de esta misma consulta (con otras líneas) ya no valen
        if replaces_older:
            for old in self.cache_dir.glob(f"{name}_*.json"):
                old.unlink()
        path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        self.downloaded += 1
        return data


# ---------------------------------------------------------------------------
# Relaciones route=bus
# ---------------------------------------------------------------------------

STOP_ROLES = ("stop", "platform")
# Palabras que no distinguen una línea de otra al comparar nombres
COMMON = {"madrid", "estacion", "plaza", "avenida", "calle", "linea", "ffcc", "circular", "urbanizacion",
          "hospital", "centro", "intercambiador", "glorieta", "paseo", "carretera", "ctra"}


def norm_ref(ref):
    """'L1' -> '1', 'N-702' -> 'N702'."""
    ref = re.sub(r"[\s\-_.]", "", (ref or "").upper())
    return ref[1:] if re.fullmatch(r"L\d+[A-Z]?", ref) else ref


def name_tokens(text):
    return {w for w in re.findall(r"[a-zñ]{4,}", plain(text)) if w not in COMMON}


def loose(text):
    """Patrón de Overpass que casa un nombre con o sin tildes: 'Móstoles' -> 'M.stoles'."""
    return "".join(c if c.isascii() and (c.isalnum() or c == " ") else "." for c in text)


def fetch_relations(overpass, name, wanted, bbox):
    """Relaciones route=bus de la zona que pueden ser de las líneas pedidas, con
    la geometría de sus tramos y las etiquetas de sus paradas.

    `wanted` es una lista de (ref, municipio | None). Para las líneas urbanas
    de un municipio solo se piden las relaciones que lo nombran (en `network`,
    `name` u `operator`): «la 1» hay en todas partes.
    """
    south, west, north, east = bbox
    box = f"({south:.3f},{west:.3f},{north:.3f},{east:.3f})"

    def ref_pattern(refs):
        variants = sorted({v for ref in refs
                           for v in (ref, f"L{ref}", f"L-{ref}", re.sub(r"^([A-Z]+)(\d)", r"\1-\2", ref))})
        return "^(" + "|".join(re.escape(v) for v in variants) + ")$"

    base = 'relation["type"="route"]["route"="bus"]'
    parts = []
    plain_refs = sorted({ref for ref, muni in wanted if not muni})
    if plain_refs:
        parts.append(f'{base}["ref"~"{ref_pattern(plain_refs)}",i]{box};')
    by_muni = {}
    for ref, muni in wanted:
        if muni:
            by_muni.setdefault(muni, []).append(ref)
    for muni, refs in sorted(by_muni.items()):
        for key in ("network", "name", "operator"):
            parts.append(f'{base}["ref"~"{ref_pattern(refs)}",i]["{key}"~"{loose(muni)}",i]{box};')
    text = f"""[out:json][timeout:200];
({" ".join(parts)})->.r;
.r out geom;
node(r.r); out body;
way(r.r:"platform"); out tags center;
way(r.r:"platform_entry_only"); out tags center;
way(r.r:"platform_exit_only"); out tags center;"""
    return overpass.query(f"relaciones_{name}", text, replaces_older=True)


class Relation:
    """Una relación route=bus ya digerida: trazado encadenado y paradas en orden."""

    def __init__(self, element, tags_by_id):
        self.id = element["id"]
        self.tags = element.get("tags", {})
        self.ref = norm_ref(self.tags.get("ref"))
        ways = []
        self.stops = []        # [{'pos': (lat, lon), 'name': str, 'ref': str, 'osm': 'node/123'}]
        for member in element.get("members", []):
            role = member.get("role", "")
            if role.startswith(STOP_ROLES):
                if member["type"] == "node" and "lat" in member:
                    pos = (member["lat"], member["lon"])
                elif member.get("geometry"):
                    pts = [(p["lat"], p["lon"]) for p in member["geometry"] if p]
                    pos = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
                else:
                    continue
                tags = tags_by_id.get((member["type"], member["ref"]), {})
                self.stops.append({
                    "pos": pos, "role": role, "name": tags.get("name", ""),
                    "ref": tags.get("ref", "") or tags.get("local_ref", ""),
                    "osm": f"{member['type']}/{member['ref']}",
                })
            elif member["type"] == "way" and member.get("geometry"):
                ways.append([(p["lat"], p["lon"]) for p in member["geometry"] if p])
        self.path, self.gaps = chain_ways(ways)

    @property
    def title(self):
        return self.tags.get("name") or f"{self.tags.get('from', '?')} → {self.tags.get('to', '?')}"

    def ends(self):
        """Textos de origen y destino (de `from`/`to` o del nombre «A → B»)."""
        name = self.tags.get("name", "")
        parts = re.split(r"\s*(?:→|=>|->|⇒)\s*", name.split(":", 1)[-1])
        start = " ".join([self.tags.get("from", ""), parts[0] if len(parts) > 1 else ""])
        end = " ".join([self.tags.get("to", ""), parts[-1] if len(parts) > 1 else ""])
        return start, end


def chain_ways(ways):
    """Une los tramos de una relación en una sola polilínea.

    Cada tramo se orienta para que empiece donde acaba el anterior. Las
    glorietas (vías cerradas) se recorren solo desde el punto de entrada hasta
    el de salida. Devuelve (polilínea, huecos), con los huecos como lista de
    (posición en la polilínea, metros) allí donde dos tramos no se tocan.
    """
    ways = [w for w in ways if len(w) >= 2]
    if not ways:
        return [], []
    path = []
    gaps = []

    def nearest_index(way, point):
        return min(range(len(way)), key=lambda i: meters(way[i], point))

    for k, way in enumerate(ways):
        nxt = ways[k + 1] if k + 1 < len(ways) else None
        closed = meters(way[0], way[-1]) < 1 and len(way) > 3
        if closed:
            ring = way[:-1]
            # entrada: donde acaba lo que llevamos; salida: donde toca el tramo siguiente
            start = nearest_index(ring, path[-1]) if path else 0
            if nxt is not None:
                touch = min((nxt[0], nxt[-1]), key=lambda p: min(meters(p, q) for q in ring))
                end = nearest_index(ring, touch)
            else:
                end = (start - 1) % len(ring)
            piece = [ring[start]]
            i = start
            while i != end:
                i = (i + 1) % len(ring)
                piece.append(ring[i])
            if not path and nxt is None:
                piece = way
        else:
            if path:
                forward = meters(path[-1], way[0]) <= meters(path[-1], way[-1])
            elif nxt is not None:
                # el primer tramo: acaba donde empieza (o acaba) el segundo
                forward = (min(meters(way[-1], nxt[0]), meters(way[-1], nxt[-1]))
                           <= min(meters(way[0], nxt[0]), meters(way[0], nxt[-1])))
            else:
                forward = True
            piece = way if forward else way[::-1]
        if path:
            gap = meters(path[-1], piece[0])
            if gap > JOIN_M:
                gaps.append((len(path), gap))
            if gap < 1:
                piece = piece[1:]
        path.extend(piece)
    return path, gaps


def parse_relations(data):
    """Lista de Relation a partir de la respuesta de fetch_relations."""
    if not data:
        return []
    tags_by_id = {}
    for element in data["elements"]:
        if element["type"] in ("node", "way") and "members" not in element:
            tags_by_id[(element["type"], element["id"])] = element.get("tags", {})
    return [Relation(e, tags_by_id) for e in data["elements"] if e["type"] == "relation"]


def relations_for_line(relations, ref, long_name, muni=None, exclude_networks=("empresa municipal",)):
    """Relaciones que son de verdad de una línea: mismo `ref` y, además, el
    municipio (urbanas) o algún topónimo del nombre largo (interurbanas)."""
    wanted = norm_ref(ref)
    tokens = name_tokens(long_name)
    out = []
    for rel in relations:
        if rel.ref != wanted or not rel.path:
            continue
        text = " ".join(rel.tags.get(k, "") for k in ("network", "name", "operator", "from", "to", "description"))
        if any(x in plain(rel.tags.get("network", "") + " " + rel.tags.get("operator", "")) for x in exclude_networks):
            continue
        if muni:
            if plain(muni) not in plain(text):
                continue
        elif tokens and not tokens & name_tokens(text):
            continue
        out.append(rel)
    return out


def split_directions(relations, long_name):
    """Elige la relación principal de cada sentido: {0: Relation, 1: Relation}.

    El sentido 0 del GTFS va del primer extremo del nombre largo («Madrid
    (Plaza de Castilla) - Colmenar Viejo») al último. Entre las variantes de un
    mismo sentido se queda con la de más paradas (a igualdad, la más larga).
    """
    segments = [s for s in re.split(r"\s+-\s+|\s*→\s*", long_name) if s.strip()]
    first, last = name_tokens(segments[0]) if segments else set(), name_tokens(segments[-1]) if segments else set()

    def direction(rel):
        start, end = (name_tokens(t) for t in rel.ends())
        forward = len(start & first) + len(end & last)
        backward = len(start & last) + len(end & first)
        return None if forward == backward else (0 if forward > backward else 1)

    by_dir = {0: [], 1: [], None: []}
    for rel in relations:
        by_dir[direction(rel)].append(rel)
    best = lambda rels: max(rels, key=lambda r: (len(r.stops), path_length(r.path)))
    chosen = {d: best(by_dir[d]) for d in (0, 1) if by_dir[d]}
    # Las que no se sabe hacia dónde van: la que salga de donde acaba la ya elegida es la vuelta
    for rel in sorted(by_dir[None], key=lambda r: -len(r.stops)):
        for d in (0, 1):
            if d in chosen:
                continue
            other = chosen.get(1 - d)
            if other is None or meters(rel.path[0], other.path[-1]) < meters(rel.path[0], other.path[0]):
                chosen[d] = rel
                break
    return chosen


# ---------------------------------------------------------------------------
# Paradas de una relación
# ---------------------------------------------------------------------------

class StopMatcher:
    """Casa paradas de OpenStreetMap con las del GTFS (por código o por cercanía)."""

    def __init__(self, coords, codes):
        self.coords = coords                  # stop_id -> (lat, lon)
        self.by_code = {}
        for stop_id, code in codes.items():
            self.by_code.setdefault(code.lstrip("0"), []).append(stop_id)
        self.cells = {}
        for stop_id, pos in coords.items():
            self.cells.setdefault(self._cell(pos), []).append(stop_id)

    @staticmethod
    def _cell(pos):
        return (int(pos[0] * 500), int(pos[1] * 400))   # celdas de unos 220 m

    def match(self, stop):
        """stop_id del GTFS que corresponde a una parada de OSM, o None."""
        pos = stop["pos"]
        digits = re.sub(r"\D", "", stop["ref"]).lstrip("0")
        if digits:
            near = [s for s in self.by_code.get(digits, []) if meters(self.coords[s], pos) <= 3 * STOP_MATCH_M]
            if near:
                return min(near, key=lambda s: meters(self.coords[s], pos))
        cx, cy = self._cell(pos)
        best, best_dist = None, STOP_MATCH_M
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for stop_id in self.cells.get((cx + dx, cy + dy), ()):
                    d = meters(self.coords[stop_id], pos)
                    if d <= best_dist:
                        best, best_dist = stop_id, d
        return best


def relation_stops(rel, matcher):
    """Paradas de una relación, en orden, casadas con las del GTFS.

    Devuelve (paradas, nuevas, casadas): `paradas` es la lista de stop_id;
    `nuevas`, las que no existen en el GTFS, como {stop_id: (nombre, lat,
    lon)}, con ids «osm_...»; `casadas`, cuántas sí estaban en el GTFS.
    """
    stops, fresh, matched = [], {}, 0
    last_pos = None
    for stop in rel.stops:
        stop_id = matcher.match(stop)
        if stop_id is None:
            # parada y andén de un mismo sitio vienen seguidos: cuentan una vez
            if last_pos is not None and meters(last_pos, stop["pos"]) < STOP_MATCH_M:
                continue
            stop_id = "osm_" + stop["osm"].replace("/", "_")
            fresh[stop_id] = (stop["name"] or "Parada", stop["pos"][0], stop["pos"][1])
        if stops and stops[-1] == stop_id:
            continue
        if stop_id in stops[-2:]:
            continue
        if not stop_id.startswith("osm_"):
            matched += 1
        stops.append(stop_id)
        last_pos = stop["pos"]
    return stops, fresh, matched


def stops_fit(path, stop_points, tolerance=70):
    """Fracción de las paradas (del GTFS) por las que pasa un trazado."""
    if not path or not stop_points:
        return 0.0
    return sum(1 for p in stop_points if distance_to_path(p, path) <= tolerance) / len(stop_points)


# ---------------------------------------------------------------------------
# Cálculo de ruta por la red viaria
# ---------------------------------------------------------------------------

DRIVABLE = ("motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|"
            "bus_guideway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|road")
# km/h aproximados por tipo de vía: se busca el camino más rápido, no el más corto
SPEED = {"motorway": 90, "trunk": 80, "primary": 50, "secondary": 45, "tertiary": 40, "unclassified": 35,
         "residential": 25, "living_street": 12, "service": 12, "busway": 40, "bus_guideway": 40, "road": 25}


class RoadNetwork:
    """Calles de una zona (de OpenStreetMap) como grafo dirigido."""

    def __init__(self, data):
        self.pos = {}          # nodo -> (lat, lon)
        self.out = {}          # nodo -> [(nodo, segundos, metros)]
        for way in data["elements"]:
            if way["type"] != "way" or "geometry" not in way:
                continue
            tags = way.get("tags", {})
            kind = tags.get("highway", "")
            base = kind.replace("_link", "")
            if tags.get("access") in ("no", "private") and tags.get("bus") != "yes" and tags.get("psv") != "yes":
                continue
            if base == "service" and tags.get("service") in ("parking_aisle", "driveway", "drive-through"):
                continue
            speed = SPEED.get(base, 25) / 3.6
            oneway = tags.get("oneway")
            if oneway is None and (tags.get("junction") in ("roundabout", "circular") or base == "motorway"):
                oneway = "yes"
            # Los autobuses pueden ir a contramano donde hay carril bus en sentido contrario
            if tags.get("oneway:bus") == "no" or tags.get("oneway:psv") == "no" or "opposite" in tags.get("busway", ""):
                oneway = "no"
            nodes = way["nodes"]
            for (a, b), (pa, pb) in zip(zip(nodes, nodes[1:]), zip(way["geometry"], way["geometry"][1:])):
                self.pos[a] = (pa["lat"], pa["lon"])
                self.pos[b] = (pb["lat"], pb["lon"])
                # Los tramos largos se trocean (un punto cada 40 m como mucho)
                # para que siempre haya un nodo cerca de cada parada.
                pieces = max(1, math.ceil(meters(self.pos[a], self.pos[b]) / 40))
                chain = [a]
                for k in range(1, pieces):
                    mid = (a, b, k)
                    self.pos[mid] = (pa["lat"] + (pb["lat"] - pa["lat"]) * k / pieces,
                                     pa["lon"] + (pb["lon"] - pa["lon"]) * k / pieces)
                    chain.append(mid)
                chain.append(b)
                for u, v in zip(chain, chain[1:]):
                    length = meters(self.pos[u], self.pos[v])
                    cost = length / speed
                    if oneway != "-1":
                        self.out.setdefault(u, []).append((v, cost, length))
                    if oneway in (None, "no", "-1", "false", "0", "reversible"):
                        self.out.setdefault(v, []).append((u, cost, length))
        self.cells = {}
        for node, pos in self.pos.items():
            self.cells.setdefault((int(pos[0] * 1000), int(pos[1] * 800)), []).append(node)

    def near(self, point, radius=90, limit=6):
        """Nodos cercanos a un punto: [(nodo, metros)], de más a menos cerca."""
        cx, cy = int(point[0] * 1000), int(point[1] * 800)
        found = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for node in self.cells.get((cx + dx, cy + dy), ()):
                    d = meters(self.pos[node], point)
                    if d <= radius:
                        found.append((d, node))
        return [(node, d) for d, node in sorted(found)[:limit]]

    def route(self, a, b, max_factor=6.0):
        """Camino más rápido entre dos puntos, como lista de (lat, lon), o None.

        Sale de cualquiera de los nodos cercanos a `a` y llega a cualquiera de
        los cercanos a `b` (alejarse de la parada penaliza). Se descarta si da
        un rodeo desproporcionado respecto a la línea recta.
        """
        starts, ends = self.near(a), dict(self.near(b))
        if not starts or not ends:
            return None
        straight = meters(a, b)
        limit = max(600.0, straight * max_factor)
        walk = 1.5                     # s por metro de separación entre la parada y la calzada
        best = {}
        back = {}
        heap = []
        for node, d in starts:
            best[node] = d * walk
            heapq.heappush(heap, (d * walk, 0.0, node))
        goal, goal_cost = None, float("inf")
        while heap:
            cost, dist, node = heapq.heappop(heap)
            if cost > best.get(node, float("inf")) or cost >= goal_cost:
                continue
            if node in ends and cost + ends[node] * walk < goal_cost:
                goal, goal_cost = node, cost + ends[node] * walk
            for nxt, secs, length in self.out.get(node, ()):
                if dist + length > limit:
                    continue
                new = cost + secs
                if new < best.get(nxt, float("inf")):
                    best[nxt] = new
                    back[nxt] = node
                    heapq.heappush(heap, (new, dist + length, nxt))
        if goal is None:
            return None
        path = [self.pos[goal]]
        node = goal
        while node in back:
            node = back[node]
            path.append(self.pos[node])
        return path[::-1]


def fetch_roads(overpass, points, margin=0.006):
    """Red viaria de la zona que ocupan unos puntos (con un margen, en grados)."""
    south = min(p[0] for p in points) - margin
    north = max(p[0] for p in points) + margin
    west = min(p[1] for p in points) - margin * 1.3
    east = max(p[1] for p in points) + margin * 1.3
    # Se redondea para que pequeños cambios en las paradas no invaliden la caché
    box = (math.floor(south * 50) / 50, math.floor(west * 50) / 50, math.ceil(north * 50) / 50, math.ceil(east * 50) / 50)
    text = (f'[out:json][timeout:200];way["highway"~"^({DRIVABLE})$"]'
            f"({box[0]:.2f},{box[1]:.2f},{box[2]:.2f},{box[3]:.2f});out geom;")
    # Un fichero de caché por zona (el nombre lleva sus coordenadas)
    data = overpass.query("calles_" + "_".join(f"{v:.2f}" for v in box), text)
    return RoadNetwork(data) if data else None


def route_between_stops(roads, stop_points):
    """Recorrido por las calles que pasa por las paradas en orden.

    Devuelve (polilínea, tramos resueltos por la red viaria, tramos en línea
    recta). Entre dos paradas sin camino razonable se tira una recta.
    """
    path = [stop_points[0]]
    routed = straight = 0
    for a, b in zip(stop_points, stop_points[1:]):
        piece = roads.route(a, b) if roads else None
        if piece and len(piece) >= 2:
            routed += 1
            path.extend(piece)
        else:
            straight += 1
        path.append(b)
    clean = [path[0]]
    for p in path[1:]:
        if meters(clean[-1], p) > 0.5:
            clean.append(p)
    return clean, routed, straight


def fill_gaps(path, gaps, roads):
    """Rellena con la red viaria los huecos de un trazado de relación.

    Devuelve (polilínea, huecos resueltos, huecos que quedan en línea recta).
    """
    if not gaps or roads is None:
        return path, 0, len(gaps)
    out, solved, left = [], 0, 0
    previous = 0
    for index, _gap in gaps:
        out.extend(path[previous:index])
        piece = roads.route(path[index - 1], path[index])
        if piece:
            out.extend(piece)
            solved += 1
        else:
            left += 1
        previous = index
    out.extend(path[previous:])
    return out, solved, left
