#!/usr/bin/env python3
"""Convierte un GTFS en ficheros JSON ligeros para la web.

Uso (desde la raíz del repo):

    python scripts/build_data.py

Por defecto lee data/raw/gtfs_emt.zip y escribe en data/emt/:

    index.json          metadatos del feed + lista de líneas
    stops.json          todas las paradas con las líneas que pasan por ellas
    lines/<id>.json     geometría y paradas de cada línea, por sentido

Solo usa la librería estándar de Python (3.9+), no hay que instalar nada.
El formato de salida está documentado en el README.
"""

import argparse
import csv
import io
import json
import math
import shutil
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------

def open_csv(zf, name):
    """Devuelve un csv.DictReader sobre un fichero del ZIP (UTF-8, con o sin BOM)."""
    return csv.DictReader(io.TextIOWrapper(zf.open(name), encoding="utf-8-sig", newline=""))


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


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")


def natural_key(route_id):
    """Ordena '2' antes que '10' y deja los ids con letras al final."""
    return (0, int(route_id), "") if route_id.isdigit() else (1, 0, route_id)


# ---------------------------------------------------------------------------
# Lectura del GTFS
# ---------------------------------------------------------------------------

def read_feed_dates(zf):
    """Fecha del feed (la más reciente de los ficheros del ZIP) y periodo de validez."""
    newest = max(info.date_time[:3] for info in zf.infolist())
    feed = {"date": date(*newest).isoformat()}
    starts, ends = [], []
    if "calendar.txt" in zf.namelist():
        for row in open_csv(zf, "calendar.txt"):
            starts.append(row["start_date"])
            ends.append(row["end_date"])
    if starts:
        iso = lambda d: f"{d[:4]}-{d[4:6]}-{d[6:8]}"
        feed["valid_from"] = iso(min(starts))
        feed["valid_to"] = iso(max(ends))
    return feed


def read_trips(zf):
    """trip_id -> (route_id, direction) y contadores de shape y cabecera por sentido."""
    trip_key = {}
    shapes = defaultdict(Counter)
    headsigns = defaultdict(Counter)
    for row in open_csv(zf, "trips.txt"):
        key = (row["route_id"], int(row.get("direction_id") or 0))
        trip_key[row["trip_id"]] = key
        if row.get("shape_id"):
            shapes[key][row["shape_id"]] += 1
        if row.get("trip_headsign"):
            headsigns[key][row["trip_headsign"].strip()] += 1
    return trip_key, shapes, headsigns


def read_patterns(zf, trip_key):
    """Recorre stop_times.txt en streaming y agrupa los viajes por secuencia de paradas.

    Devuelve {(route_id, direction): {tupla_de_paradas: [n_viajes, tiempos, distancias]}}.
    Los tiempos (s) y distancias (m) son acumulados desde la primera parada y se
    guardan solo del primer viaje visto con cada secuencia.
    """
    patterns = defaultdict(dict)
    seen = set()

    def flush(trip_id, rows):
        key = trip_key.get(trip_id)
        if key is None or not rows:
            return
        rows.sort(key=lambda r: r[0])
        stops = tuple(r[1] for r in rows)
        entry = patterns[key].get(stops)
        if entry:
            entry[0] += 1
            return
        t0 = rows[0][2]
        d0 = rows[0][3]
        times = [None if (r[2] is None or t0 is None) else r[2] - t0 for r in rows]
        dists = [None if (r[3] is None or d0 is None) else round(r[3] - d0) for r in rows]
        patterns[key][stops] = [1, times, dists]

    with zf.open("stop_times.txt") as raw:
        reader = csv.reader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
        header = next(reader)
        col = {name: i for i, name in enumerate(header)}
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


def read_shapes(zf, wanted):
    """shape_id -> lista ordenada de (lat, lon), solo para los shapes pedidos."""
    points = defaultdict(list)
    with zf.open("shapes.txt") as raw:
        reader = csv.reader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
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
            if not clean or clean[-1] != (lat, lon):
                clean.append((lat, lon))
        shapes[shape_id] = clean
    return shapes


# ---------------------------------------------------------------------------
# Programa principal
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Preprocesa un GTFS para el mapa de buses.")
    ap.add_argument("--input", default=str(ROOT / "data" / "raw" / "gtfs_emt.zip"),
                    help="ZIP del GTFS (por defecto data/raw/gtfs_emt.zip)")
    ap.add_argument("--output", default=str(ROOT / "data" / "emt"),
                    help="carpeta de salida (por defecto data/emt)")
    ap.add_argument("--network-id", default="emt")
    ap.add_argument("--network-name", default="EMT Madrid")
    ap.add_argument("--tolerance", type=float, default=2.0,
                    help="tolerancia de simplificación de la geometría, en metros")
    ap.add_argument("--date", default=None,
                    help="fecha de actualización del GTFS (AAAA-MM-DD); "
                         "si no se indica se usa la de los ficheros del ZIP")
    args = ap.parse_args()

    src = Path(args.input)
    out = Path(args.output)
    if not src.exists():
        sys.exit(f"ERROR: no existe {src}. Descarga el GTFS y guárdalo ahí.")

    with zipfile.ZipFile(src) as zf:
        print(f"Leyendo {src} ...")
        feed = read_feed_dates(zf)
        if args.date:
            feed["date"] = args.date

        routes = {r["route_id"]: r for r in open_csv(zf, "routes.txt")}
        trip_key, shape_count, headsign_count = read_trips(zf)
        print(f"  {len(routes)} líneas, {len(trip_key)} viajes")

        print("  leyendo stop_times.txt (tarda un poco) ...")
        patterns = read_patterns(zf, trip_key)

        wanted = {c.most_common(1)[0][0] for c in shape_count.values()}
        shapes = read_shapes(zf, wanted)

        stops_raw = {s["stop_id"]: s for s in open_csv(zf, "stops.txt")}

    # --- Líneas ------------------------------------------------------------
    stop_lines = defaultdict(set)   # stop_id -> {route_id}
    lines_index = []
    lines_dir = out / "lines"
    if lines_dir.exists():
        shutil.rmtree(lines_dir)    # evita que queden líneas que ya no existen
    pts_before = pts_after = 0
    warnings = []

    for route_id in sorted(routes, key=natural_key):
        route = routes[route_id]
        name = (route.get("route_short_name") or route_id).strip()
        long_name = (route.get("route_long_name") or "").strip(" -")
        dirs = []
        for direction in (0, 1):
            key = (route_id, direction)
            pats = patterns.get(key)
            if not pats:
                continue
            # Todas las paradas de todas las variantes cuentan para "qué líneas pasan"
            for stops in pats:
                for stop_id in stops:
                    stop_lines[stop_id].add(route_id)
            # Variante representativa: la más frecuente (y, a igualdad, la más larga)
            stops, (n_trips, times, dists) = max(
                pats.items(), key=lambda kv: (kv[1][0], len(kv[0])))
            if len(pats) > 1:
                warnings.append(f"línea {name} sentido {direction}: {len(pats)} variantes "
                                f"de recorrido; se usa la más frecuente")
            shape = []
            if shape_count.get(key):
                shape = shapes.get(shape_count[key].most_common(1)[0][0], [])
            if not shape:
                # Sin shape: unimos las paradas en línea recta
                warnings.append(f"línea {name} sentido {direction}: sin shape, se unen las paradas")
                shape = [(float(stops_raw[s]["stop_lat"]), float(stops_raw[s]["stop_lon"]))
                         for s in stops if s in stops_raw]
            simple = simplify(shape, args.tolerance)
            pts_before += len(shape)
            pts_after += len(simple)
            headsign = ""
            if headsign_count.get(key):
                headsign = headsign_count[key].most_common(1)[0][0]
            dirs.append({
                "dir": direction,
                "headsign": headsign,
                "shape": encode_polyline(simple),
                "stops": list(stops),
                "dist": dists,
                "time": times,
            })
        if not dirs:
            warnings.append(f"línea {name}: sin viajes, se omite")
            continue
        write_json(lines_dir / f"{route_id}.json",
                   {"id": route_id, "name": name, "long": long_name, "dirs": dirs})
        lines_index.append({
            "id": route_id,
            "name": name,
            "long": long_name,
            "dirs": [{"dir": d["dir"], "headsign": d["headsign"], "stops": len(d["stops"])}
                     for d in dirs],
        })

    names = Counter(l["name"].upper() for l in lines_index)
    for dup in [n for n, c in names.items() if c > 1]:
        warnings.append(f"nombre corto de línea repetido: {dup}")

    # --- Paradas -----------------------------------------------------------
    order = {l["id"]: i for i, l in enumerate(lines_index)}
    stops_out = []
    for stop_id, s in stops_raw.items():
        served = stop_lines.get(stop_id)
        if not served:
            continue            # paradas sin ninguna línea: no aportan nada al mapa
        stops_out.append([
            stop_id,
            (s.get("stop_code") or stop_id).strip(),
            " ".join(s["stop_name"].split()),
            round(float(s["stop_lat"]), 6),
            round(float(s["stop_lon"]), 6),
            sorted(served, key=lambda r: order[r]),
        ])
    missing = set(stop_lines) - set(stops_raw)
    if missing:
        warnings.append(f"{len(missing)} paradas de stop_times.txt no están en stops.txt")

    write_json(out / "stops.json", {
        "fields": ["id", "code", "name", "lat", "lon", "lines"],
        "stops": stops_out,
    })
    write_json(out / "index.json", {
        "network": {"id": args.network_id, "name": args.network_name},
        "feed": feed,
        "generated": date.today().isoformat(),
        "lines": lines_index,
    })

    # --- Resumen -----------------------------------------------------------
    size = sum(f.stat().st_size for f in out.rglob("*.json"))
    print(f"\nEscrito en {out}:")
    print(f"  {len(lines_index)} líneas, {len(stops_out)} paradas "
          f"({len(stops_raw) - len(stops_out)} sin servicio descartadas)")
    print(f"  geometría: {pts_before} -> {pts_after} puntos (tolerancia {args.tolerance} m)")
    print(f"  tamaño total: {size / 1024:.0f} KB")
    print(f"  fecha del GTFS: {feed['date']}")
    if warnings:
        print(f"\nAvisos ({len(warnings)}):")
        for w in warnings[:40]:
            print("  -", w)
        if len(warnings) > 40:
            print(f"  ... y {len(warnings) - 40} más")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
