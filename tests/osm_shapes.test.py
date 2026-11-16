#!/usr/bin/env python3
"""Prueba de la reconstrucción de recorridos con OpenStreetMap.

    python tests/osm_shapes.test.py

El GTFS actual no tiene ninguna línea con paradas pero sin trazado, así que el
cálculo de ruta por la red viaria (el método 'routed' de scripts/osm_shapes.py)
no llega a usarse al generar los datos. Para saber si funcionaría, aquí se
aplica a líneas que SÍ tienen trazado en el GTFS y se compara el resultado con
el oficial: se ignora su shape, se calcula la ruta entre paradas consecutivas
por las calles de OpenStreetMap y se mide cuánto se separa de la real.

Descarga (una vez; queda en data/raw/osm/) las calles de la zona de cada línea
de prueba. Necesita los GTFS en data/raw/.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import build_data as bd          # noqa: E402
import osm_shapes                # noqa: E402

# (red, route_id del GTFS, descripción)
CASES = [
    ("urb", "9__1__127_", "Las Rozas · 1"),
    ("urb", "9__1__903_", "Tres Cantos · 1"),
    ("urb", "9__2__092_", "Móstoles · 2"),
]


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    overpass = osm_shapes.Overpass(bd.RAW / "osm")
    failures = 0
    feeds = {}
    for net_id, route_id, label in CASES:
        src = bd.RAW / bd.NETWORKS[net_id]["zip"]
        if not src.exists():
            print(f"(sin {src.name}: no se prueba {label})")
            continue
        if net_id not in feeds:
            feed = bd.Feed(src)
            trips = {t["trip_id"]: t for t in feed.rows("trips.txt") if t["route_id"] in {c[1] for c in CASES}}
            coords = {s["stop_id"]: (float(s["stop_lat"]), float(s["stop_lon"])) for s in feed.rows("stops.txt")}
            sequences = {}          # trip_id -> [(orden, parada)]
            with feed.text("stop_times.txt") as text:
                header = text.readline().strip().split(",")
                i_trip, i_stop, i_seq = (header.index(k) for k in ("trip_id", "stop_id", "stop_sequence"))
                for row in text:
                    parts = row.rstrip("\n").split(",")
                    if parts[i_trip] in trips:
                        sequences.setdefault(parts[i_trip], []).append((int(parts[i_seq]), parts[i_stop]))
            wanted = {t["shape_id"] for t in trips.values()}
            feeds[net_id] = (trips, coords, sequences, bd.read_shapes(feed, wanted))
            feed.close()
        trips, coords, sequences, shapes = feeds[net_id]

        # El viaje con más paradas del sentido 0 de la línea
        own = [t for t in trips.values() if t["route_id"] == route_id and t["direction_id"] == "0" and t["trip_id"] in sequences]
        trip = max(own, key=lambda t: len(sequences[t["trip_id"]]))
        stops = [coords[s] for _, s in sorted(sequences[trip["trip_id"]])]
        real = shapes[trip["shape_id"]]

        roads = osm_shapes.fetch_roads(overpass, stops)
        if roads is None:
            print(f"{label}: no se ha podido descargar la red viaria (Overpass no responde); prueba más tarde")
            failures += 1
            continue
        path, routed, straight = osm_shapes.route_between_stops(roads, stops)
        # Separación del recorrido calculado respecto al oficial, punto a punto
        gaps = sorted(osm_shapes.distance_to_path(p, real) for p in path)
        median, p90 = gaps[len(gaps) // 2], gaps[int(len(gaps) * 0.9)]
        ratio = osm_shapes.path_length(path) / osm_shapes.path_length(real)
        ok = routed >= 0.8 * (routed + straight) and median <= 15 and p90 <= 120 and 0.8 <= ratio <= 1.3
        failures += not ok
        print(f"{'✓' if ok else '✗'} {label}: {len(stops)} paradas, {routed} tramos por calles y {straight} en recta · "
              f"separación del trazado oficial: mediana {median:.0f} m, percentil 90 {p90:.0f} m · "
              f"longitud {osm_shapes.path_length(path) / 1000:.1f} km frente a {osm_shapes.path_length(real) / 1000:.1f} km")
    print("Todo correcto" if not failures else f"{failures} comprobaciones fallidas")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
