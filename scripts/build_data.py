#!/usr/bin/env python3
"""Convierte los GTFS de las redes de autobús en ficheros JSON ligeros para la web.

Uso (desde la raíz del repo):

    python scripts/build_data.py              todas las redes cuyo ZIP exista
    python scripts/build_data.py emt          solo la EMT
    python scripts/build_data.py inter urb    solo las dos redes del CRTM

Redes (ver NETWORKS más abajo):

    emt     data/raw/gtfs_emt.zip            ->  data/emt/
    inter   data/raw/gtfs_interurbanos.zip   ->  data/inter/
    urb     data/raw/gtfs_urbanos.zip        ->  data/urb/

Cada carpeta de salida contiene:

    index.json          metadatos del feed + lista de líneas
    stops.json          paradas de la red con las líneas que pasan por ellas
    lines/<línea>.json  geometría y paradas de cada línea, por sentido
    routing.json        datos del buscador de rutas: recorridos, horarios y calendario

Solo usa la librería estándar de Python (3.9+), no hay que instalar nada.
El formato de salida está documentado en el README.
"""

import argparse
import csv
import io
import json
import math
import re
import shutil
import sys
import unicodedata
import zipfile
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"

# Versión del formato de routing.json (la web la comprueba al cargarlo).
ROUTING_VERSION = 2

# En las redes «por frecuencia» (EMT), una franja cuyo intervalo medio supera
# este valor se trata en la web como horario (se espera a la siguiente salida)
# y no como frecuencia (se espera medio intervalo).
SCHEDULE_HEADWAY_S = 15 * 60

# Redes que sabe procesar el script.
#   kind      'emt'  -> identificadores y nombres tal cual vienen; el GTFS trae
#                       frequencies.txt y las salidas se resumen en franjas.
#             'crtm' -> GTFS del Consorcio: nombres en mayúsculas que se pasan a
#                       un formato legible, calendario por línea y horarios que
#                       se guardan exactos (son líneas de poca frecuencia).
#   prefix    prefijo del identificador de línea: emt:27, inter:625...
#   by_muni   las líneas se identifican por municipio: urb-colmenar-viejo:1
NETWORKS = {
    "emt": {
        "name": "EMT Madrid", "zip": "gtfs_emt.zip", "out": "emt",
        "kind": "emt", "prefix": "emt", "by_muni": False, "exact": False, "tolerance": 2.0,
    },
    "inter": {
        "name": "Interurbanos (CRTM)", "zip": "gtfs_interurbanos.zip", "out": "inter",
        "kind": "crtm", "prefix": "inter", "by_muni": False, "exact": True, "tolerance": 4.0,
    },
    "urb": {
        "name": "Urbanos de otros municipios (CRTM)", "zip": "gtfs_urbanos.zip", "out": "urb",
        "kind": "crtm", "prefix": "urb", "by_muni": True, "exact": True, "tolerance": 3.0,
    },
}

# Municipios de la Comunidad de Madrid por su código INE (los tres últimos
# dígitos; el GTFS de urbanos del CRTM lo lleva al final del route_id:
# «9__1__045_» es la línea 1 de Colmenar Viejo, 28045).
MUNICIPIOS = {
    "001": "La Acebeda", "002": "Ajalvir", "003": "Alameda del Valle", "004": "El Álamo",
    "005": "Alcalá de Henares", "006": "Alcobendas", "007": "Alcorcón", "008": "Aldea del Fresno",
    "009": "Algete", "010": "Alpedrete", "011": "Ambite", "012": "Anchuelo", "013": "Aranjuez",
    "014": "Arganda del Rey", "015": "Arroyomolinos", "016": "El Atazar", "017": "Batres",
    "018": "Becerril de la Sierra", "019": "Belmonte de Tajo", "020": "Berzosa del Lozoya",
    "021": "El Berrueco", "022": "Boadilla del Monte", "023": "El Boalo", "024": "Braojos",
    "025": "Brea de Tajo", "026": "Brunete", "027": "Buitrago del Lozoya", "028": "Bustarviejo",
    "029": "Cabanillas de la Sierra", "030": "La Cabrera", "031": "Cadalso de los Vidrios",
    "032": "Camarma de Esteruelas", "033": "Campo Real", "034": "Canencia", "035": "Carabaña",
    "036": "Casarrubuelos", "037": "Cenicientos", "038": "Cercedilla", "039": "Cervera de Buitrago",
    "040": "Ciempozuelos", "041": "Cobeña", "042": "Colmenar del Arroyo", "043": "Colmenar de Oreja",
    "044": "Colmenarejo", "045": "Colmenar Viejo", "046": "Collado Mediano", "047": "Collado Villalba",
    "048": "Corpa", "049": "Coslada", "050": "Cubas de la Sagra", "051": "Chapinería",
    "052": "Chinchón", "053": "Daganzo de Arriba", "054": "El Escorial", "055": "Estremera",
    "056": "Fresnedillas de la Oliva", "057": "Fresno de Torote", "058": "Fuenlabrada",
    "059": "Fuente el Saz de Jarama", "060": "Fuentidueña de Tajo", "061": "Galapagar",
    "062": "Garganta de los Montes", "063": "Gargantilla del Lozoya", "064": "Gascones",
    "065": "Getafe", "066": "Griñón", "067": "Guadalix de la Sierra", "068": "Guadarrama",
    "069": "La Hiruela", "070": "Horcajo de la Sierra", "071": "Horcajuelo de la Sierra",
    "072": "Hoyo de Manzanares", "073": "Humanes de Madrid", "074": "Leganés", "075": "Loeches",
    "076": "Lozoya", "078": "Madarcos", "079": "Madrid", "080": "Majadahonda",
    "082": "Manzanares el Real", "083": "Meco", "084": "Mejorada del Campo",
    "085": "Miraflores de la Sierra", "086": "El Molar", "087": "Los Molinos",
    "088": "Montejo de la Sierra", "089": "Moraleja de Enmedio", "090": "Moralzarzal",
    "091": "Morata de Tajuña", "092": "Móstoles", "093": "Navacerrada", "094": "Navalafuente",
    "095": "Navalagamella", "096": "Navalcarnero", "097": "Navarredonda y San Mamés",
    "099": "Navas del Rey", "100": "Nuevo Baztán", "101": "Olmeda de las Fuentes",
    "102": "Orusco de Tajuña", "104": "Paracuellos de Jarama", "106": "Parla", "107": "Patones",
    "108": "Pedrezuela", "109": "Pelayos de la Presa", "110": "Perales de Tajuña",
    "111": "Pezuela de las Torres", "112": "Pinilla del Valle", "113": "Pinto",
    "114": "Piñuécar-Gandullas", "115": "Pozuelo de Alarcón", "116": "Pozuelo del Rey",
    "117": "Prádena del Rincón", "118": "Puebla de la Sierra", "119": "Quijorna", "120": "Rascafría",
    "121": "Redueña", "122": "Ribatejada", "123": "Rivas-Vaciamadrid", "124": "Robledillo de la Jara",
    "125": "Robledo de Chavela", "126": "Robregordo", "127": "Las Rozas", "128": "Rozas de Puerto Real",
    "129": "San Agustín del Guadalix", "130": "San Fernando de Henares",
    "131": "San Lorenzo de El Escorial", "132": "San Martín de la Vega",
    "133": "San Martín de Valdeiglesias", "134": "San Sebastián de los Reyes",
    "135": "Santa María de la Alameda", "136": "Santorcaz", "137": "Los Santos de la Humosa",
    "138": "La Serna del Monte", "140": "Serranillos del Valle", "141": "Sevilla la Nueva",
    "143": "Somosierra", "144": "Soto del Real", "145": "Talamanca de Jarama", "146": "Tielmes",
    "147": "Titulcia", "148": "Torrejón de Ardoz", "149": "Torrejón de la Calzada",
    "150": "Torrejón de Velasco", "151": "Torrelaguna", "152": "Torrelodones",
    "153": "Torremocha de Jarama", "154": "Torres de la Alameda", "155": "Valdaracete",
    "156": "Valdeavero", "157": "Valdelaguna", "158": "Valdemanco", "159": "Valdemaqueda",
    "160": "Valdemorillo", "161": "Valdemoro", "162": "Valdeolmos-Alalpardo", "163": "Valdepiélagos",
    "164": "Valdetorres de Jarama", "165": "Valdilecha", "166": "Valverde de Alcalá",
    "167": "Velilla de San Antonio", "168": "El Vellón", "169": "Venturada", "170": "Villaconejos",
    "171": "Villa del Prado", "172": "Villalbilla", "173": "Villamanrique de Tajo",
    "174": "Villamanta", "175": "Villamantilla", "176": "Villanueva de la Cañada",
    "177": "Villanueva del Pardillo", "178": "Villanueva de Perales", "179": "Villar del Olmo",
    "180": "Villarejo de Salvanés", "181": "Villaviciosa de Odón", "182": "Villavieja del Lozoya",
    "183": "Zarzalejo", "901": "Lozoyuela-Navas-Sieteiglesias", "902": "Puentes Viejas",
    "903": "Tres Cantos",
}


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------

def parse_time(text):
    """'HH:MM:SS' -> segundos (las horas pueden pasar de 24 en GTFS)."""
    try:
        h, m, s = text.strip().split(":")
        return int(h) * 3600 + int(m) * 60 + int(s)
    except ValueError:
        return None


def to_number(text):
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def parse_date(text):
    """'AAAAMMDD' -> date."""
    return date(int(text[:4]), int(text[4:6]), int(text[6:8]))


def meters(a, b):
    """Distancia aproximada en metros entre dos puntos (lat, lon) cercanos."""
    kx = 111320.0 * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((a[1] - b[1]) * kx, (a[0] - b[0]) * 110540.0)


def simplify(points, tolerance_m):
    """Douglas-Peucker sobre una lista de (lat, lon). Tolerancia en metros."""
    if len(points) < 3:
        return list(points)
    lat0 = math.radians(points[0][0])
    kx = 111320.0 * math.cos(lat0)
    ky = 110540.0
    xy = [(lon * kx, lat * ky) for lat, lon in points]

    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    tol2 = tolerance_m * tolerance_m
    while stack:
        a, b = stack.pop()
        ax, ay = xy[a]
        bx, by = xy[b]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        worst, worst_i = -1.0, -1
        for i in range(a + 1, b):
            px, py = xy[i]
            if seg2 == 0:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
                d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d2 > worst:
                worst, worst_i = d2, i
        if worst > tol2:
            keep[worst_i] = True
            stack.append((a, worst_i))
            stack.append((worst_i, b))
    return [p for p, k in zip(points, keep) if k]


def encode_polyline(points, precision=5):
    """Algoritmo 'Encoded Polyline' de Google (lat, lon) con 5 decimales."""
    factor = 10 ** precision
    out = []
    prev_lat = prev_lon = 0
    for lat, lon in points:
        ilat, ilon = round(lat * factor), round(lon * factor)
        for delta in (ilat - prev_lat, ilon - prev_lon):
            value = ~(delta << 1) if delta < 0 else delta << 1
            while value >= 0x20:
                out.append(chr((0x20 | (value & 0x1F)) + 63))
                value >>= 5
            out.append(chr(value + 63))
        prev_lat, prev_lon = ilat, ilon
    return "".join(out)


def project_stops(shape, stop_points):
    """Distancia (m) a lo largo de `shape` del punto más cercano a cada parada.

    Las paradas se buscan en orden y siempre hacia delante. Para no saltar a
    otra pasada por la misma calle (líneas circulares, ida y vuelta por la
    misma vía), en cuanto se encuentra un punto a menos de 60 m se deja de
    mirar más allá de 600 m de él. Devuelve una lista de enteros crecientes.
    """
    if len(shape) < 2:
        return [0] * len(stop_points)
    lat0 = math.radians(shape[0][0])
    kx, ky = 111320.0 * math.cos(lat0), 110540.0
    xy = [(lon * kx, lat * ky) for lat, lon in shape]
    cum = [0.0]
    for (ax, ay), (bx, by) in zip(xy, xy[1:]):
        cum.append(cum[-1] + math.hypot(bx - ax, by - ay))

    out = []
    seg, along = 0, 0.0   # posición de la parada anterior
    for lat, lon in stop_points:
        px, py = lon * kx, lat * ky
        best = None       # (distancia a la línea, tramo, metros desde el inicio)
        good = None       # primer candidato «bueno» (a menos de 60 m)
        for i in range(seg, len(xy) - 1):
            ax, ay = xy[i]
            bx, by = xy[i + 1]
            dx, dy = bx - ax, by - ay
            seg2 = dx * dx + dy * dy
            t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
            pos = cum[i] + t * math.sqrt(seg2)
            if pos < along:
                continue
            d = math.hypot(px - ax - t * dx, py - ay - t * dy)
            if good is not None and cum[i] > good[2] + 600:
                break
            if best is None or d < best[0]:
                best = (d, i, pos)
                if d <= 60 and (good is None or d < good[0]):
                    good = best
        chosen = good or best
        if chosen is not None:
            seg, along = chosen[1], chosen[2]
        out.append(round(along))
    return out


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")


def natural_key(text):
    """Ordena '2' antes que '10', y 'N1' después de los números."""
    m = re.fullmatch(r"(\d+)(.*)", text)
    if m:
        return (0, int(m.group(1)), m.group(2).upper())
    m = re.fullmatch(r"(\D+?)(\d+)(.*)", text)
    if m:
        return (1, m.group(1).upper(), int(m.group(2)), m.group(3).upper())
    return (2, text.upper())


def slugify(text):
    """'Colmenar Viejo' -> 'colmenar-viejo' (sin tildes, para ids y ficheros)."""
    plain = unicodedata.normalize("NFD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-")


def file_key(line_id):
    """Nombre de fichero de una línea a partir de su identificador.

    'emt:27' -> '27', 'inter:625' -> '625', 'urb-colmenar-viejo:1' -> 'colmenar-viejo_1'.
    (La web hace lo mismo en js/data.js: lineFile.)
    """
    prefix, name = line_id.split(":", 1)
    name = re.sub(r"[^A-Za-z0-9_-]", "-", name)
    return f"{prefix[4:]}_{name}" if prefix.startswith("urb-") else name


# ---------------------------------------------------------------------------
# Nombres legibles (el GTFS del CRTM viene en mayúsculas y con abreviaturas)
# ---------------------------------------------------------------------------

SMALL_WORDS = {"de", "del", "la", "las", "los", "el", "y", "e", "a", "al", "en", "con", "por", "o", "u"}
ACRONYMS = {
    "FFCC", "UPM", "ETSI", "PAU", "IES", "CEIP", "UAM", "URJC", "UNED", "ITV", "RENFE", "AVE",
    "EMT", "CRTM", "INTA", "INEF", "IFEMA", "TVE", "RTVE", "UVA", "CC", "PP", "SS", "RR", "AA",
    "EEUU", "ONU", "UE", "CEPA", "CP", "PK", "KM", "UFV", "UEM", "CAM", "HM", "IVIMA", "EADS",
}
ROMAN = re.compile(r"^(?=[IVX]{2,})X{0,3}(IX|IV|V?I{0,3})$")
# Nombres compuestos que llevan guion (no es un separador «origen-destino»).
COMPOUNDS = {("rivas", "vaciamadrid"), ("valdeolmos", "alalpardo"), ("lozoyuela", "navas"),
             ("navas", "sieteiglesias"), ("piñuécar", "gandullas"), ("piñuecar", "gandullas")}
WORD = re.compile(r"[^\W\d_]+", re.UNICODE)


def nice_name(text):
    """Pasa a formato legible un nombre en mayúsculas del CRTM.

    'AV.CONSTITUCIÓN-PZA.ESPAÑA'  -> 'Av. Constitución - Pza. España'
    'MADRID (Legazpi)-PINTO'      -> 'Madrid (Legazpi) - Pinto'
    Las palabras que ya vienen en minúsculas o mezcladas no se tocan.
    """
    text = " ".join(text.replace("\u00a0", " ").split())
    if not text:
        return text
    text = re.sub(r"\bF\.?F\.?\s?C\.?C\b\.?", "FFCC", text)
    text = re.sub(r"(?<=[ºª])(?=[^\W\d_])", " ", text)     # «PºDELICIAS» -> «Pº DELICIAS»

    def fix(match):
        word = match.group(0)
        if len(word) == 1 or word != word.upper():
            return word                      # letra suelta (A-6, N-I) o ya en minúsculas
        if word in ACRONYMS or ROMAN.match(word):
            return word
        lower = word.lower()
        before = match.string[:match.start()].rstrip()
        starts = not before or before[-1] in "-(/:"
        if lower in SMALL_WORDS and not starts:
            return lower
        return lower[0].upper() + lower[1:]

    text = WORD.sub(fix, text)
    text = re.sub(r"\bde el (Escorial|Molar|Álamo|Pardo|Vellón|Boalo|Berrueco)\b", r"de El \1", text)
    # «Av.Constitución» -> «Av. Constitución»
    text = re.sub(r"(?<=[^\W\d_]{2})\.(?=[^\W\d_])", ". ", text)

    # Guion como separador: «A-B» -> «A - B», salvo en nombres compuestos
    # (Rivas-Vaciamadrid) y en códigos de carretera o similares (A-6, M-607, N-I).
    parts = text.split("-")
    out = parts[0]
    for left, right in zip(parts, parts[1:]):
        lw = re.search(r"([^\W_]+)[).]*$", left)
        rw = re.match(r"[(]*([^\W_]+)", right)
        if left.endswith(" ") or right.startswith(" "):
            tight = False
        elif not lw or not rw:
            tight = True
        else:
            a, b = lw.group(1), rw.group(1)
            tight = ((len(a) <= 2 and (b[0].isdigit() or len(b) <= 2))
                     or (a.lower(), b.lower()) in COMPOUNDS)
        out = out + "-" + right if tight else out.rstrip() + " - " + right.lstrip()
    return " ".join(out.split())


# ---------------------------------------------------------------------------
# Lectura del GTFS
# ---------------------------------------------------------------------------

class Feed:
    """Un ZIP de GTFS. Los ficheros pueden estar en la raíz o en una carpeta."""

    def __init__(self, path):
        self.zf = zipfile.ZipFile(path)
        self.names = {Path(n).name: n for n in self.zf.namelist() if n.endswith(".txt")}

    def close(self):
        self.zf.close()

    def has(self, name):
        return name in self.names

    def text(self, name):
        return io.TextIOWrapper(self.zf.open(self.names[name]), encoding="utf-8-sig", newline="")

    def rows(self, name):
        """Filas de un fichero como diccionarios (lista vacía si no existe)."""
        return csv.DictReader(self.text(name)) if self.has(name) else []

    def zip_date(self):
        """Fecha más reciente de los ficheros del ZIP."""
        newest = max(info.date_time[:3] for info in self.zf.infolist()
                     if info.filename in self.names.values())
        return date(*newest)


def read_calendar(feed):
    """service_id -> conjunto de fechas (date) en las que funciona."""
    names = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
    services = {}
    for row in feed.rows("calendar.txt"):
        start, end = parse_date(row["start_date"]), parse_date(row["end_date"])
        mask = [int(row[n] or 0) for n in names]
        days = set()
        d = start
        while d <= end:
            if mask[d.weekday()]:
                days.add(d)
            d += timedelta(days=1)
        services[row["service_id"]] = days
    last_exception = None
    for row in feed.rows("calendar_dates.txt"):
        d = parse_date(row["date"])
        days = services.setdefault(row["service_id"], set())
        if int(row["exception_type"]) == 1:
            days.add(d)
        else:
            days.discard(d)
        if last_exception is None or d > last_exception:
            last_exception = d
    return services, last_exception


def read_frequencies(feed):
    """trip_id -> (inicio, fin, intervalo) de frequencies.txt, si el feed lo trae.

    En el GTFS de la EMT cada viaje tiene su hora real en stop_times.txt y
    además una fila aquí que dice a qué franja de frecuencia pertenece.
    """
    freq = {}
    for row in feed.rows("frequencies.txt"):
        freq[row["trip_id"]] = (parse_time(row["start_time"]), parse_time(row["end_time"]),
                                int(row["headway_secs"]))
    return freq


def read_trips(feed, kind, short_names):
    """trip_id -> (route_id, sentido, service_id, shape_id, cabecera)."""
    trips = {}
    for row in feed.rows("trips.txt"):
        headsign = (row.get("trip_headsign") or "").strip()
        if kind == "crtm":
            # En el CRTM trip_headsign es el nombre de la última parada; el
            # destino «de verdad» va en trip_short_name: «421 PINTO».
            # A veces con un prefijo de tipo de día: «sdf 2 CEMENTERIO».
            words = (row.get("trip_short_name") or "").split()
            name = short_names.get(row["route_id"], "").upper()
            for k, word in enumerate(words[:3]):
                if name and word.upper() == name and k + 1 < len(words):
                    words = words[k + 1:]
                    break
            headsign = nice_name(" ".join(words) or headsign)
        trips[row["trip_id"]] = (row["route_id"], int(row.get("direction_id") or 0),
                                 row["service_id"], row.get("shape_id") or "", headsign)
    return trips


def clean_times(times):
    """Arregla las horas de paso de un viaje.

    - Si pasan de las 23:59 a las 00:00 sin sumar 24 h, se suman.
    - Un dato suelto que va hacia atrás (errores del GTFS del CRTM) se
      sustituye por el anterior: un autobús no retrocede en el tiempo.
    """
    out = []
    shift = 0
    prev = None
    for t in times:
        if t is None:
            out.append(None)
            continue
        t += shift
        if prev is not None and t < prev:
            if prev - t > 12 * 3600:
                shift += 86400
                t += 86400
            else:
                t = prev
        out.append(t)
        prev = t
    return out


class Pattern:
    """Un recorrido: todos los viajes de una línea y sentido con la misma
    secuencia de paradas."""

    __slots__ = ("stops", "trips", "dists", "shapes", "headsigns", "profile", "estimated")

    def __init__(self, stops):
        self.stops = stops
        self.trips = []            # [(trip_id, salida, perfil | None)]
        self.dists = None          # metros acumulados (si el GTFS los trae)
        self.shapes = Counter()
        self.headsigns = Counter()
        self.profile = None        # perfil de referencia: segundos acumulados por parada
        self.estimated = False     # True si el perfil no sale de horas reales


def read_patterns(feed, trips):
    """Recorre stop_times.txt en streaming y agrupa los viajes por secuencia de paradas.

    Devuelve {(route_id, sentido): {tupla_de_paradas: Pattern}}. De cada viaje
    se guarda su hora de salida y su «perfil» (segundos desde la salida en cada
    parada), o None si el GTFS no trae horas de paso útiles para ese viaje.
    """
    patterns = defaultdict(dict)
    profiles = {}          # para no repetir en memoria perfiles idénticos
    seen = set()

    def flush(trip_id, rows):
        info = trips.get(trip_id)
        if info is None or len(rows) < 2:
            return
        rows.sort(key=lambda r: r[0])
        stops = tuple(r[1] for r in rows)
        key = (info[0], info[1])
        pat = patterns[key].get(stops)
        if pat is None:
            pat = patterns[key][stops] = Pattern(stops)
            d0 = rows[0][3]
            if d0 is not None and all(r[3] is not None for r in rows):
                pat.dists = [round(r[3] - d0) for r in rows]
        if info[3]:
            pat.shapes[info[3]] += 1
        if info[4]:
            pat.headsigns[info[4]] += 1
        times = clean_times([r[2] for r in rows])
        if times[0] is None:
            return
        profile = None
        if all(t is not None for t in times):
            rel = tuple(t - times[0] for t in times)
            hops = len(rel) - 1
            flat = sum(1 for a, b in zip(rel, rel[1:]) if a == b)
            # Sin horas de paso: todas iguales, o casi todas (solo algún punto de control)
            if rel[-1] > 0 and not (hops > 3 and flat > 0.6 * hops):
                profile = profiles.setdefault(rel, rel)
        pat.trips.append((trip_id, times[0], profile))

    with feed.text("stop_times.txt") as text:
        reader = csv.reader(text)
        col = {name: i for i, name in enumerate(next(reader))}
        i_trip, i_stop, i_seq = col["trip_id"], col["stop_id"], col["stop_sequence"]
        i_time = col.get("arrival_time")
        i_dist = col.get("shape_dist_traveled")
        current, rows = None, []
        for rec in reader:
            if not rec:
                continue
            trip_id = rec[i_trip]
            if trip_id != current:
                flush(current, rows)
                if trip_id in seen:
                    sys.exit("ERROR: stop_times.txt no está agrupado por trip_id; "
                             "ordénalo antes de ejecutar este script.")
                seen.add(trip_id)
                current, rows = trip_id, []
            rows.append((
                int(rec[i_seq]),
                rec[i_stop],
                parse_time(rec[i_time]) if i_time is not None else None,
                to_number(rec[i_dist]) if i_dist is not None else None,
            ))
        flush(current, rows)
    return patterns


def read_shapes(feed, wanted):
    """shape_id -> lista ordenada de (lat, lon), solo para los shapes pedidos."""
    points = defaultdict(list)
    with feed.text("shapes.txt") as text:
        reader = csv.reader(text)
        col = {name: i for i, name in enumerate(next(reader))}
        i_id, i_lat, i_lon, i_seq = (col["shape_id"], col["shape_pt_lat"],
                                     col["shape_pt_lon"], col["shape_pt_sequence"])
        for rec in reader:
            if rec and rec[i_id] in wanted:
                points[rec[i_id]].append((int(rec[i_seq]), float(rec[i_lat]), float(rec[i_lon])))
    shapes = {}
    for shape_id, pts in points.items():
        pts.sort()
        clean = []
        for _, lat, lon in pts:
            if not clean or meters(clean[-1], (lat, lon)) > 0.3:
                clean.append((lat, lon))
        shapes[shape_id] = clean
    return shapes


def drop_catch_all_services(patterns, trips, calendar):
    """Quita los servicios «cajón de sastre» del GTFS del CRTM.

    Algunas líneas traen, además de sus servicios normales (laborables,
    sábados, festivos...), un servicio que dice funcionar TODOS los días y que
    repite, con un segundo de desfase, los viajes de todos los demás. Si se
    tomara al pie de la letra, un martes pasarían a la vez los autobuses del
    horario de laborables, los del sábado y los del domingo.

    Se detecta así: casi todos sus viajes (90 %) tienen un «gemelo» (mismo
    recorrido, salida a menos de un minuto) en otro servicio, y entre esos
    otros servicios hay al menos dos que nunca coinciden en fecha (por ejemplo,
    uno de laborables y otro de sábados). Devuelve los servicios quitados.
    """
    twins = defaultdict(Counter)       # servicio -> {servicio gemelo: nº de viajes}
    with_twin = Counter()
    total = Counter()
    for pats in patterns.values():
        for pat in pats.values():
            ordered = sorted(pat.trips, key=lambda t: t[1])
            for i, (trip_id, start, _) in enumerate(ordered):
                service = trips[trip_id][2]
                total[service] += 1
                found = set()
                for step in (-1, 1):
                    j = i + step
                    while 0 <= j < len(ordered) and abs(ordered[j][1] - start) <= 60:
                        other = trips[ordered[j][0]][2]
                        if other != service:
                            found.add(other)
                        j += step
                if found:
                    with_twin[service] += 1
                    for other in found:
                        twins[service][other] += 1
    dropped = set()
    for service, n in total.items():
        if with_twin[service] < 0.9 * n:
            continue
        mask = calendar.masks.get(service, 0)
        others = [o for o in twins[service] if o not in dropped]
        # ¿Mezcla viajes de servicios que nunca coinciden entre sí y que él engloba?
        mixes = any(
            calendar.masks.get(a, 0) and calendar.masks.get(b, 0)
            and not calendar.masks[a] & calendar.masks[b]
            and (calendar.masks[a] | calendar.masks[b]) & mask == calendar.masks[a] | calendar.masks[b]
            for i, a in enumerate(others) for b in others[i + 1:])
        if mixes:
            dropped.add(service)
    if dropped:
        for pats in patterns.values():
            for pat in pats.values():
                pat.trips = [t for t in pat.trips if trips[t[0]][2] not in dropped]
    return dropped, sum(total[s] for s in dropped)


# ---------------------------------------------------------------------------
# Tiempos de recorrido
# ---------------------------------------------------------------------------

# Tramos de distancia (m, en línea recta entre paradas) para el modelo de velocidad.
SPEED_BUCKETS = (300, 700, 1500, 4000, 10000)


def bucket_of(dist):
    for i, limit in enumerate(SPEED_BUCKETS):
        if dist < limit:
            return i
    return len(SPEED_BUCKETS)


def build_time_model(patterns, coords):
    """Aprende de los viajes con horas reales cuánto se tarda entre paradas.

    Devuelve (hops, speeds):
      hops    {(parada_a, parada_b): mediana de segundos observados}
      speeds  velocidad mediana (m/s) por tramo de distancia entre paradas
    Sirve para estimar los viajes que el GTFS trae sin horas de paso.
    """
    hop_times = defaultdict(list)
    for pats in patterns.values():
        for pat in pats.values():
            counts = Counter(profile for _, _, profile in pat.trips if profile)
            for profile, n in counts.items():
                for a, b, ta, tb in zip(pat.stops, pat.stops[1:], profile, profile[1:]):
                    hop_times[(a, b)] += [tb - ta] * min(n, 5)
    hops = {k: median(v) for k, v in hop_times.items()}
    by_bucket = defaultdict(list)
    for (a, b), secs in hops.items():
        if secs <= 0 or a not in coords or b not in coords:
            continue
        dist = meters(coords[a], coords[b])
        if dist > 20:
            by_bucket[bucket_of(dist)].append(dist / secs)
    # Valores de partida razonables (km/h) por si faltan datos en algún tramo
    default = [14, 20, 28, 42, 60, 75]
    speeds = [median(by_bucket[i]) if len(by_bucket[i]) >= 20 else default[i] / 3.6
              for i in range(len(SPEED_BUCKETS) + 1)]
    return hops, speeds


def estimate_profile(stops, coords, hops, speeds):
    """Perfil de tiempos estimado para una secuencia de paradas."""
    out = [0]
    for a, b in zip(stops, stops[1:]):
        secs = hops.get((a, b))
        if secs is None or secs <= 0:
            dist = meters(coords[a], coords[b]) if a in coords and b in coords else 400
            secs = max(20, dist / speeds[bucket_of(dist)])
        out.append(out[-1] + secs)
    return [round(t) for t in out]


def resolve_profiles(patterns, coords):
    """Decide el perfil de referencia de cada recorrido y la duración de cada viaje.

    Tras esto, cada viaje es (trip_id, salida, duración) y cada Pattern tiene
    `profile` (segundos acumulados; el último es la duración de referencia).
    Devuelve (viajes estimados, viajes en total).
    """
    hops, speeds = build_time_model(patterns, coords)
    estimated = total = 0
    for pats in patterns.values():
        for pat in pats.values():
            timed = [p for _, _, p in pat.trips if p]
            if timed:
                # El perfil más repetido; a igualdad, el de duración mediana
                counts = Counter(timed)
                top = max(counts.values())
                best = sorted(p for p, n in counts.items() if n == top)
                pat.profile = list(best[len(best) // 2])
                typical = round(median(p[-1] for p in timed))
            else:
                pat.profile = estimate_profile(pat.stops, coords, hops, speeds)
                pat.estimated = True
                typical = pat.profile[-1]
            trips = []
            for trip_id, start, profile in pat.trips:
                total += 1
                if profile is None:
                    estimated += 1
                trips.append((trip_id, start, profile[-1] if profile else typical))
            pat.trips = trips
    return estimated, total


# ---------------------------------------------------------------------------
# Horarios
# ---------------------------------------------------------------------------

def frequency_bands(trips, freq):
    """Resume las salidas de un recorrido en un tipo de día en «franjas» (EMT).

    `trips` es una lista de (trip_id, salida, duración). Devuelve una lista
    plana [primera, última, n, duración, ...]: en cada franja hay `n` salidas
    repartidas de forma regular entre `primera` y `última` (segundos desde las
    0:00 del día de servicio; pueden pasar de 24 h), y el recorrido completo
    dura `duración` segundos.

    Se agrupan las salidas consecutivas que comparten franja de frequencies.txt.
    Si una franja tiene intervalos largos e irregulares, se guarda salida a
    salida para no inventar horas.
    """
    trips = sorted(trips, key=lambda t: t[1])
    groups = []
    for trip in trips:
        key = freq.get(trip[0])
        last = groups[-1] if groups else None
        if last and key is not None and last["key"] == key:
            last["trips"].append(trip)
        elif (last and key is None and last["key"] is None
              and (len(last["trips"]) == 1
                   or abs((trip[1] - last["trips"][-1][1])
                          - (last["trips"][1][1] - last["trips"][0][1])) <= 60)
              and abs(trip[2] - last["trips"][0][2]) <= 0.15 * max(last["trips"][0][2], 1)):
            last["trips"].append(trip)
        else:
            groups.append({"key": key, "trips": [trip]})

    bands = []
    for group in groups:
        starts = [t[1] for t in group["trips"]]
        n = len(starts)
        regular = True
        if n > 2:
            mean = (starts[-1] - starts[0]) / (n - 1)
            if mean > SCHEDULE_HEADWAY_S:
                regular = all(abs((b - a) - mean) <= 120 for a, b in zip(starts, starts[1:]))
        if regular:
            bands += [starts[0], starts[-1], n, round(median(t[2] for t in group["trips"]))]
        else:
            for trip in group["trips"]:
                bands += [trip[1], trip[1], 1, trip[2]]
    return bands


def exact_bands(pairs):
    """Guarda el horario SIN PÉRDIDA, comprimiendo las salidas regulares (CRTM).

    `pairs` es una lista de (salida, duración). Mismo formato de salida que
    frequency_bands, pero aquí una franja solo agrupa salidas con exactamente
    el mismo intervalo y la misma duración, así que de ella se recuperan las
    horas originales: primera + k × intervalo.
    """
    pairs = sorted(set(pairs))
    bands = []
    i, n = 0, len(pairs)
    while i < n:
        start, dur = pairs[i]
        j = i
        if i + 1 < n and pairs[i + 1][1] == dur:
            gap = pairs[i + 1][0] - start
            j = i + 1
            while j + 1 < n and pairs[j + 1][1] == dur and pairs[j + 1][0] - pairs[j][0] == gap:
                j += 1
        bands += [start, pairs[j][0], j - i + 1, dur]
        i = j + 1
    return bands


class Calendar:
    """Calendario de servicio como conjuntos de fechas.

    Cada «conjunto» es un entero cuyos bits son los días (bit 0 = primer día de
    la ventana) en que se aplica un horario. Los service_id del GTFS con el
    mismo horario se funden en uno, así que salen pocos conjuntos distintos.
    """

    def __init__(self, services, start, end):
        self.start = start
        self.days = (end - start).days + 1
        self.masks = {}
        for service_id, dates in services.items():
            mask = 0
            for d in dates:
                offset = (d - start).days
                if 0 <= offset < self.days:
                    mask |= 1 << offset
            self.masks[service_id] = mask
        self.sets = []           # máscaras únicas, en orden de aparición
        self.index = {}

    def set_index(self, mask):
        if mask not in self.index:
            self.index[mask] = len(self.sets)
            self.sets.append(mask)
        return self.index[mask]

    def active(self, mask, day):
        return bool(mask >> (day - self.start).days & 1) if self.start <= day else False

    def hex(self, mask):
        """Máscara como texto hexadecimal: el carácter k lleva los días 4k..4k+3."""
        digits = []
        for k in range(0, self.days, 4):
            digits.append("%x" % (mask >> k & 15))
        return "".join(digits)

    def week_mask(self, mask, since):
        """Días de la semana (bit 0 = lunes) en que el conjunto funciona de forma
        habitual: en la mitad o más de las 8 semanas que siguen a `since`. Es lo
        que usa la web para las fechas que quedan fuera de la ventana."""
        end = self.start + timedelta(days=self.days - 1)
        out = 0
        for weekday in range(7):
            dates = []
            d = since
            while d <= end and len(dates) < 8:
                if d.weekday() == weekday:
                    dates.append(d)
                d += timedelta(days=1)
            if dates and sum(self.active(mask, x) for x in dates) * 2 >= len(dates):
                out |= 1 << weekday
        return out


def find_holidays(calendar, trip_services, first, last):
    """Fechas entre `first` y `last` (de lunes a sábado) que el feed trata como
    festivo: funcionan menos de la mitad de los viajes de un día normal igual.

    Se usa para aplicar el horario de festivo en las redes cuyo GTFS no detalla
    esa fecha (ver prepareDay en js/router.js).
    """
    per_service = Counter(trip_services)
    holidays = []
    if last is None:
        return holidays
    day = first
    while day <= last:
        if day.weekday() < 6:
            # Día de referencia: el mismo día de la semana, pasado el detalle del feed
            ref = last + timedelta(days=1)
            while ref.weekday() != day.weekday():
                ref += timedelta(days=1)
            normal = sum(n for s, n in per_service.items() if calendar.active(calendar.masks.get(s, 0), ref))
            same = sum(n for s, n in per_service.items()
                       if calendar.active(calendar.masks.get(s, 0), ref)
                       and calendar.active(calendar.masks.get(s, 0), day))
            if normal and same < 0.5 * normal:
                holidays.append(day.isoformat())
        day += timedelta(days=1)
    return holidays


def build_routing(net, patterns, line_index, stop_index, trips, freq, calendar, feed_date, detail_to):
    """Monta routing.json: todos los recorridos con sus horarios por conjunto de fechas."""
    out = []
    used_trips = []
    skipped = 0
    for (route_id, direction), pats in patterns.items():
        if route_id not in line_index:
            continue
        for pat in pats.values():
            if any(s not in stop_index for s in pat.stops) or pat.profile[-1] <= 0:
                skipped += 1
                continue
            by_bands = {}      # horario (tupla de franjas) -> fechas en que se aplica
            if net["exact"]:
                # El CRTM usa un service_id por línea y bloque de viajes, así
                # que el calendario se resuelve salida a salida: de cada una,
                # todas las fechas en que sale, y se agrupan las que coinciden.
                when = defaultdict(int)
                for trip_id, start, dur in pat.trips:
                    service_id = trips[trip_id][2]
                    if start % 60 == 1:
                        start -= 1     # «06:40:01»: segundo suelto que mete el GTFS
                    when[(start, dur)] |= calendar.masks.get(service_id, 0)
                    used_trips.append(service_id)
                by_mask = defaultdict(list)
                for pair, mask in when.items():
                    if mask:
                        by_mask[mask].append(pair)
                for mask, pairs in by_mask.items():
                    by_bands[tuple(exact_bands(pairs))] = mask
            else:
                # EMT: pocos servicios (laborable, sábado, festivo...); los que
                # tienen el mismo horario se funden uniendo sus fechas.
                by_service = defaultdict(list)
                for trip in pat.trips:
                    by_service[trips[trip[0]][2]].append(trip)
                for service_id, lst in sorted(by_service.items()):
                    mask = calendar.masks.get(service_id, 0)
                    if not mask:
                        continue
                    bands = tuple(frequency_bands(lst, freq))
                    by_bands[bands] = by_bands.get(bands, 0) | mask
                    used_trips += [service_id] * len(lst)
            if not by_bands:
                continue
            entry = {
                "line": line_index[route_id],
                "dir": direction,
                "stops": [stop_index[s] for s in pat.stops],
                "time": pat.profile,
                "bands": sorted([calendar.set_index(mask), list(bands)] for bands, mask in by_bands.items()),
            }
            if pat.estimated:
                entry["est"] = 1
            out.append(entry)
    out.sort(key=lambda p: (p["line"], p["dir"], -sum(len(b[1]) for b in p["bands"])))
    since = max(feed_date, detail_to + timedelta(days=1)) if detail_to else feed_date
    routing = {
        "version": ROUTING_VERSION,
        "network": net["id"],
        "exact": net["exact"],
        "scheduleHeadway": SCHEDULE_HEADWAY_S,
        "calendar": {
            "start": calendar.start.isoformat(),
            "days": calendar.days,
            "detailTo": (detail_to or calendar.start).isoformat(),
            "holidays": find_holidays(calendar, used_trips, feed_date, detail_to),
            "sets": [calendar.hex(mask) for mask in calendar.sets],
            "week": [calendar.week_mask(mask, since) for mask in calendar.sets],
        },
        "patterns": out,
    }
    return routing, skipped


# ---------------------------------------------------------------------------
# Una red
# ---------------------------------------------------------------------------

def line_identity(net, route, taken):
    """Identificador único, nombre y municipio de una línea."""
    name = (route.get("route_short_name") or route["route_id"]).strip()
    muni = None
    prefix = net["prefix"]
    if net["by_muni"]:
        # «9__1__045_» -> código INE 045 -> Colmenar Viejo
        m = re.search(r"_(\d{3})_?$", route["route_id"])
        code = m.group(1) if m else ""
        muni = MUNICIPIOS.get(code)
        if muni is None:
            muni = f"Municipio {code or '?'}"
        prefix = f"{net['prefix']}-{slugify(muni)}"
    line_id = f"{prefix}:{name}"
    n = 2
    while line_id in taken or file_key(line_id).lower() in taken:
        line_id = f"{prefix}:{name}-{n}"
        n += 1
    taken.add(line_id)
    taken.add(file_key(line_id).lower())
    return line_id, name, muni


def build_network(net, src, out, tolerance=None, feed_date=None):
    tolerance = tolerance or net["tolerance"]
    crtm = net["kind"] == "crtm"
    print(f"\n=== {net['name']} ({net['id']}) ===")
    print(f"Leyendo {src} ...")
    feed = Feed(src)
    zip_date = feed.zip_date()
    feed_date = feed_date or zip_date
    versions = sorted({row.get("feed_version", "") for row in feed.rows("feed_info.txt")} - {""})

    routes = {r["route_id"]: r for r in feed.rows("routes.txt")}
    short_names = {rid: (r.get("route_short_name") or "").strip() for rid, r in routes.items()}
    trips = read_trips(feed, net["kind"], short_names)
    services, last_exception = read_calendar(feed)
    freq = read_frequencies(feed)
    stops_raw = {s["stop_id"]: s for s in feed.rows("stops.txt")}
    coords = {sid: (float(s["stop_lat"]), float(s["stop_lon"])) for sid, s in stops_raw.items()
              if s.get("stop_lat") and s.get("stop_lon")}
    print(f"  {len(routes)} líneas, {len(trips)} viajes, {len(services)} servicios de calendario")

    # Ventana del calendario: desde la fecha del feed hasta el último día con servicio.
    # Los servicios que ya habían caducado al publicarse el feed se descartan.
    all_days = [d for days in services.values() for d in days if d >= feed_date]
    if not all_days:
        sys.exit("ERROR: el calendario del GTFS no tiene ningún día de servicio desde la fecha del feed.")
    calendar = Calendar(services, feed_date, max(all_days))
    detail_to = last_exception if last_exception and last_exception >= feed_date else None
    alive = {s for s, mask in calendar.masks.items() if mask}

    print("  leyendo stop_times.txt (tarda un poco) ...")
    patterns = read_patterns(feed, {t: info for t, info in trips.items() if info[2] in alive})
    dropped_services, dropped_trips = drop_catch_all_services(patterns, trips, calendar) if crtm else (set(), 0)
    for key in [k for k, pats in patterns.items() if not any(p.trips for p in pats.values())]:
        del patterns[key]
    for pats in patterns.values():
        for stops in [st for st, p in pats.items() if not p.trips]:
            del pats[stops]
    estimated, total_trips = resolve_profiles(patterns, coords)

    # Recorrido principal de cada línea y sentido: el de más viajes (a igualdad, el más largo)
    main = {key: max(pats.values(), key=lambda p: (len(p.trips), len(p.stops)))
            for key, pats in patterns.items() if pats}
    wanted = {pat.shapes.most_common(1)[0][0] for pat in main.values() if pat.shapes}
    print(f"  leyendo shapes.txt ({len(wanted)} trazados) ...")
    shapes = read_shapes(feed, wanted) if wanted and feed.has("shapes.txt") else {}
    feed.close()

    # --- Líneas ------------------------------------------------------------
    warnings = []
    taken = set()
    lines = []
    for route_id, route in routes.items():
        dirs = [d for d in (0, 1) if (route_id, d) in main]
        line_id, name, muni = line_identity(net, route, taken)
        if not dirs:
            # Pasa en el GTFS del CRTM: la línea está en routes.txt pero no trae
            # viajes, paradas ni trazado. Se lista para que conste, sin datos.
            where = f" de {muni}" if muni else ""
            warnings.append(f"línea {name}{where}: el GTFS no trae viajes en vigor; se lista sin recorrido")
        long_name = (route.get("route_long_name") or "").strip(" -")
        lines.append({"route": route_id, "id": line_id, "name": name, "muni": muni,
                      "long": nice_name(long_name) if crtm else long_name, "dirs": dirs})
    lines.sort(key=lambda l: (slugify(l["muni"] or ""), natural_key(l["name"])))
    line_index = {l["route"]: i for i, l in enumerate(lines)}

    lines_dir = out / "lines"
    if lines_dir.exists():
        shutil.rmtree(lines_dir)    # evita que queden líneas que ya no existen
    stop_lines = defaultdict(set)   # stop_id -> {índice de línea}
    lines_index = []
    pts_before = pts_after = 0
    n_variants = 0

    for i, line in enumerate(lines):
        route_id = line["route"]
        if not line["dirs"]:
            entry = {"id": line["id"], "name": line["name"], "long": line["long"], "nodata": True}
            if line["muni"]:
                entry["muni"] = line["muni"]
            lines_index.append({**entry, "dirs": []})
            continue
        dirs = []
        for direction in line["dirs"]:
            key = (route_id, direction)
            pats = patterns[key]
            # Todas las paradas de todas las variantes cuentan para «qué líneas pasan»
            for pat in pats.values():
                for stop_id in pat.stops:
                    stop_lines[stop_id].add(i)
            n_variants += len(pats) - 1
            pat = main[key]
            stop_points = [coords[s] for s in pat.stops if s in coords]
            shape = shapes.get(pat.shapes.most_common(1)[0][0], []) if pat.shapes else []
            if len(shape) < 2:
                warnings.append(f"línea {line['name']} sentido {direction}: sin trazado, se unen las paradas")
                shape = stop_points
            simple = simplify(shape, tolerance)
            pts_before += len(shape)
            pts_after += len(simple)
            dists = pat.dists
            if dists is None and len(stop_points) == len(pat.stops):
                dists = project_stops(simple, stop_points)
            headsign = pat.headsigns.most_common(1)[0][0] if pat.headsigns else ""
            dirs.append({
                "dir": direction,
                "headsign": headsign,
                "shape": encode_polyline(simple),
                "stops": list(pat.stops),
                "dist": dists,
                "time": pat.profile,
            })
        entry = {"id": line["id"], "name": line["name"], "long": line["long"]}
        if line["muni"]:
            entry["muni"] = line["muni"]
        write_json(lines_dir / f"{file_key(line['id'])}.json", {**entry, "dirs": dirs})
        lines_index.append({
            **entry,
            "dirs": [{"dir": d["dir"], "headsign": d["headsign"], "stops": len(d["stops"])} for d in dirs],
        })

    # --- Paradas -----------------------------------------------------------
    stops_out = []
    for stop_id, s in stops_raw.items():
        served = stop_lines.get(stop_id)
        if not served or stop_id not in coords:
            continue            # paradas sin ninguna línea: no aportan nada al mapa
        name = " ".join(s["stop_name"].split())
        stops_out.append([
            stop_id,
            (s.get("stop_code") or stop_id).strip(),
            nice_name(name) if crtm else name,
            round(coords[stop_id][0], 6),
            round(coords[stop_id][1], 6),
            sorted(served),
        ])
    missing = set(stop_lines) - set(coords)
    if missing:
        warnings.append(f"{len(missing)} paradas de stop_times.txt no están en stops.txt")
    write_json(out / "stops.json", {
        "fields": ["id", "code", "name", "lat", "lon", "lines"],
        "stops": stops_out,
    })

    # --- Buscador de rutas -------------------------------------------------
    # Las paradas se referencian por su posición en stops.json y las líneas
    # por su posición en index.json.
    stop_index = {s[0]: i for i, s in enumerate(stops_out)}
    routing, skipped = build_routing(net, patterns, line_index, stop_index, trips, freq,
                                     calendar, feed_date, detail_to)
    write_json(out / "routing.json", routing)
    n_bands = sum(len(b[1]) // 4 for p in routing["patterns"] for b in p["bands"])
    n_departures = sum(b[1][k + 2] for p in routing["patterns"] for b in p["bands"]
                       for k in range(0, len(b[1]), 4))
    if skipped:
        warnings.append(f"{skipped} recorridos sin paradas o tiempos válidos, no entran en las rutas")

    feed_info = {"date": feed_date.isoformat(),
                 "valid_from": calendar.start.isoformat(),
                 "valid_to": (calendar.start + timedelta(days=calendar.days - 1)).isoformat()}
    if versions:
        feed_info["version"] = versions[-1]
    write_json(out / "index.json", {
        "network": {"id": net["id"], "name": net["name"]},
        "feed": feed_info,
        "generated": date.today().isoformat(),
        "lines": lines_index,
    })

    # --- Resumen -----------------------------------------------------------
    size = sum(f.stat().st_size for f in out.rglob("*.json"))
    kb = lambda name: (out / name).stat().st_size / 1024
    print(f"\nEscrito en {out}:")
    n_nodata = sum(1 for l in lines_index if l.get("nodata"))
    print(f"  {len(lines_index) - n_nodata} líneas ({n_variants} variantes de recorrido además de las principales)"
          + (f" y {n_nodata} más sin datos en el GTFS" if n_nodata else "")
          + f", {len(stops_out)} paradas")
    print(f"  geometría: {pts_before} -> {pts_after} puntos (tolerancia {tolerance} m)")
    print(f"  rutas: {len(routing['patterns'])} recorridos, {n_departures} salidas en {n_bands} franjas, "
          f"{len(routing['calendar']['sets'])} calendarios")
    if dropped_services:
        print(f"  servicios duplicados «de todos los días» descartados: {len(dropped_services)} "
              f"({dropped_trips} viajes repetidos)")
    print(f"  viajes sin horas de paso en el GTFS (tiempo estimado): {estimated} de {total_trips}")
    print(f"  festivos detectados: {', '.join(routing['calendar']['holidays']) or 'ninguno'} "
          f"(detalle del calendario hasta {routing['calendar']['detailTo']})")
    print(f"  index.json {kb('index.json'):.0f} KB · stops.json {kb('stops.json'):.0f} KB · "
          f"routing.json {kb('routing.json'):.0f} KB · total {size / 1024:.0f} KB")
    print(f"  fecha del GTFS: {feed_info['date']}" + (f" (versión {versions[-1]})" if versions else ""))
    if warnings:
        print(f"\nAvisos ({len(warnings)}):")
        for w in warnings[:25]:
            print("  -", w)
        if len(warnings) > 25:
            print(f"  ... y {len(warnings) - 25} más")


# ---------------------------------------------------------------------------
# Programa principal
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Preprocesa los GTFS de las redes de autobús para la web.",
        epilog="Sin argumentos procesa todas las redes cuyo ZIP esté en data/raw/.")
    ap.add_argument("networks", nargs="*", metavar="red",
                    help="redes a procesar: " + ", ".join(NETWORKS))
    ap.add_argument("--input", help="ZIP del GTFS (solo con una red; por defecto, data/raw/<zip de la red>)")
    ap.add_argument("--output", help="carpeta de salida (solo con una red; por defecto, data/<red>)")
    ap.add_argument("--tolerance", type=float,
                    help="tolerancia de simplificación de la geometría, en metros")
    ap.add_argument("--date", help="fecha de actualización del GTFS (AAAA-MM-DD; solo con una red); "
                                   "si no se indica se usa la de los ficheros del ZIP")
    args = ap.parse_args()

    chosen = args.networks or list(NETWORKS)
    unknown = [n for n in chosen if n not in NETWORKS]
    if unknown:
        sys.exit(f"ERROR: red desconocida: {', '.join(unknown)}. Las que hay: {', '.join(NETWORKS)}.")
    if (args.input or args.output or args.date) and len(chosen) != 1:
        sys.exit("ERROR: --input, --output y --date solo valen al procesar una red.")

    done = 0
    for net_id in chosen:
        net = {"id": net_id, **NETWORKS[net_id]}
        src = Path(args.input) if args.input else RAW / net["zip"]
        if not src.exists():
            message = f"no existe {src}"
            if args.networks:
                sys.exit(f"ERROR: {message}. Descarga el GTFS y guárdalo ahí.")
            print(f"\n=== {net['name']} ({net_id}) ===\n  {message}: se salta esta red.")
            continue
        out = Path(args.output) if args.output else ROOT / "data" / net["out"]
        feed_date = date.fromisoformat(args.date) if args.date else None
        build_network(net, src, out, args.tolerance, feed_date)
        done += 1
    if not done:
        sys.exit("ERROR: no hay ningún GTFS en data/raw/. Mira el README.")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
