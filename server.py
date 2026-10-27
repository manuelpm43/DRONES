import base64
import binascii
import io
import json
import importlib.util
import logging
import math
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np
import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

_rasterio_spec = importlib.util.find_spec("rasterio")
if _rasterio_spec and _rasterio_spec.origin:
    _bundled_proj_data = Path(_rasterio_spec.origin).parent / "proj_data"
    if (_bundled_proj_data / "proj.db").is_file():
        os.environ["PROJ_DATA"] = str(_bundled_proj_data)
        os.environ["PROJ_LIB"] = str(_bundled_proj_data)

import rasterio
from flask import Flask, jsonify, request, send_file, send_from_directory
from rasterio.errors import RasterioError
from rasterio.io import MemoryFile
from rasterio.mask import mask
from rasterio.merge import merge
from rasterio.warp import (
    Resampling,
    calculate_default_transform,
    reproject,
    transform_bounds,
    transform_geom,
)
from shapely.errors import ShapelyError
from shapely.geometry import box, mapping, shape
from shapely.ops import unary_union


ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
MAX_UPLOAD_BYTES = int(os.environ.get("MDT02_MAX_UPLOAD_BYTES", str(1024 * 1024 * 1024)))
MAX_AREA_KM2 = float(os.environ.get("MDT02_MAX_AREA_KM2", "50"))
MAX_FILES = int(os.environ.get("MDT02_MAX_FILES", "20"))
MAX_PROJECT_RASTER_BYTES = int(
    os.environ.get("DRONES_MAX_RASTER_BYTES", str(64 * 1024 * 1024))
)
# Lado máximo, en píxeles, de la vista previa que se pinta en el mapa.
PREVIEW_MAX_SIZE = 1024
PORT = int(os.environ.get("PORT", "5000"))
# Nombres de host desde los que se sirve el visor. En el servidor se añade su
# dominio público (p. ej. drones.geospatiallab.xyz) con DRONES_ALLOWED_HOSTS.
ALLOWED_HOSTS = {"localhost", "127.0.0.1"} | {
    host.strip().lower()
    for host in os.environ.get("DRONES_ALLOWED_HOSTS", "").split(",")
    if host.strip()
}
PRODUCTS = {
    "MDT02": {
        "label": "Modelo Digital del Terreno",
        "filename": "MDT02_recortado.tif",
    },
    "MDS02": {
        "label": "Modelo Digital de Superficies",
        "filename": "MDS02_recortado.tif",
    },
}
PROJECT_COLUMNS = """id, name, geometry, area_m2, centroid_x, centroid_y,
                     utm_zone, utm_epsg, created_at, updated_at"""

app = Flask(__name__, static_folder=str(ROOT / "static"), static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES
app.logger.setLevel(logging.INFO)


class RequestError(Exception):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


class DatabaseUnavailable(Exception):
    pass


@app.before_request
def require_allowed_request_origin():
    if not request.path.startswith("/api/") or request.path == "/api/health":
        return None

    request_url = urlsplit("http://" + request.host)
    if request_url.hostname not in ALLOWED_HOSTS:
        return jsonify(error="El procesador no acepta peticiones para este dominio."), 403

    # Una página de otro sitio no puede usar la API: el origen debe ser el propio visor.
    origin = request.headers.get("Origin")
    if origin:
        origin_url = urlsplit(origin)
        if (
            origin_url.scheme not in {"http", "https"}
            or origin_url.netloc.lower() != request.host.lower()
        ):
            return jsonify(error="Origen de petición no permitido."), 403
    return None


@app.get("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.get("/api/health")
def health():
    return jsonify(status="ok", processor="rasterio")


@app.post("/api/clip")
def clip_rasters():
    geometry_text = request.form.get("geometry", "")
    uploads = {
        product: request.files.getlist("rasters_" + product)
        for product in PRODUCTS
    }
    uploads = {product: files for product, files in uploads.items() if files}

    if not uploads:
        raise RequestError("Selecciona los GeoTIFF del CNIG de MDT02, MDS02 o ambos.")
    for product, files in uploads.items():
        if len(files) > MAX_FILES:
            raise RequestError(
                "Has seleccionado demasiados archivos {} (máximo {}).".format(product, MAX_FILES)
            )
    if not geometry_text:
        raise RequestError("Dibuja el polígono antes de iniciar el recorte.")

    geometry = parse_geometry(geometry_text)
    rasters = [clip_product(product, files, geometry) for product, files in uploads.items()]
    response = jsonify(rasters=rasters)
    response.headers["Cache-Control"] = "no-store"
    return response


def clip_product(product, files, geometry):
    work_dir = Path(tempfile.mkdtemp(prefix="drones-"))
    try:
        source_paths, source_names = save_uploaded_files(files, work_dir)
        output_path, output_name, output_metadata = create_clipped_raster(
            source_paths, geometry, work_dir, product, source_names
        )
        data = output_path.read_bytes()
    except RequestError:
        raise
    except (RasterioError, ValueError, OSError) as error:
        app.logger.warning("No se pudo procesar %s: %s", product, error)
        raise RequestError(
            "No se pudo leer o recortar el GeoTIFF {}. Comprueba que los archivos "
            "sean de ese producto y que cubran el polígono.".format(product),
            422,
        )
    except Exception:
        app.logger.exception("Error inesperado durante el recorte %s", product)
        raise
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    return {
        "product": product,
        "filename": output_name,
        "size_bytes": len(data),
        "metadata": output_metadata,
        "data": base64.b64encode(data).decode("ascii"),
        "preview": raster_preview(data),
    }


def raster_preview(data):
    """Cotas del GeoTIFF reproyectadas a Web Mercator para pintarlas en el mapa.

    Devuelve una malla float32 (NaN fuera del polígono) de como máximo
    PREVIEW_MAX_SIZE píxeles de lado y sus límites en latitud/longitud.
    Cada celda toma la cota máxima de los píxeles que cubre, para que el
    análisis de colisiones del visor no pierda obstáculos al reducir resolución.
    """
    with MemoryFile(data) as memory_file, memory_file.open() as source:
        dst_crs = "EPSG:3857"
        transform, width, height = calculate_default_transform(
            source.crs, dst_crs, source.width, source.height, *source.bounds
        )
        scale = max(width, height) / PREVIEW_MAX_SIZE
        if scale > 1:
            transform, width, height = calculate_default_transform(
                source.crs,
                dst_crs,
                source.width,
                source.height,
                *source.bounds,
                dst_width=max(1, round(width / scale)),
                dst_height=max(1, round(height / scale)),
            )

        grid = np.full((height, width), np.nan, dtype=np.float32)
        reproject(
            source=rasterio.band(source, 1),
            destination=grid,
            src_transform=source.transform,
            src_crs=source.crs,
            src_nodata=source.nodata,
            dst_transform=transform,
            dst_crs=dst_crs,
            dst_nodata=np.nan,
            resampling=Resampling.max,
        )

    west, south, east, north = transform_bounds(
        dst_crs,
        "EPSG:4326",
        *rasterio.transform.array_bounds(height, width, transform),
    )
    valid = grid[np.isfinite(grid)]
    return {
        "width": width,
        "height": height,
        "bounds": [[south, west], [north, east]],
        # Tamaño real del píxel en metros: Web Mercator lo amplía en 1/cos(latitud).
        "cell_size": abs(transform.a) * math.cos(math.radians((south + north) / 2)),
        "min": float(valid.min()) if valid.size else None,
        "max": float(valid.max()) if valid.size else None,
        "data": base64.b64encode(grid.astype("<f4").tobytes()).decode("ascii"),
    }


@app.get("/api/projects")
def list_projects():
    try:
        with connect_database() as connection:
            rows = connection.execute(
                """
                SELECT p.id, p.name, p.area_m2, p.centroid_x, p.centroid_y,
                       p.utm_epsg, p.updated_at,
                       COALESCE(
                           array_agg(r.product ORDER BY r.product)
                               FILTER (WHERE r.product IS NOT NULL),
                           '{}'
                       ) AS products
                FROM public.proyectos p
                LEFT JOIN public.proyecto_rasters r ON r.proyecto_id = p.id
                GROUP BY p.id
                ORDER BY p.updated_at DESC, p.id DESC
                """
            ).fetchall()
        return jsonify(projects=[serialize_project(row) for row in rows])
    except (DatabaseUnavailable, psycopg.Error) as error:
        return database_error(error)


@app.get("/api/projects/<int:project_id>")
def get_project(project_id):
    try:
        with connect_database() as connection:
            row = connection.execute(
                "SELECT " + PROJECT_COLUMNS + " FROM public.proyectos WHERE id = %s",
                (project_id,),
            ).fetchone()
            if not row:
                return jsonify(error="No existe el proyecto solicitado."), 404
            rasters = fetch_project_rasters(connection, project_id)
        return jsonify(project=serialize_project(row, rasters))
    except (DatabaseUnavailable, psycopg.Error) as error:
        return database_error(error)


@app.get("/api/projects/<int:project_id>/rasters/<product>")
def download_project_raster(project_id, product):
    try:
        row = fetch_project_raster_data(project_id, product)
    except (DatabaseUnavailable, psycopg.Error) as error:
        return database_error(error)

    response = send_file(
        io.BytesIO(bytes(row["data"])),
        mimetype="image/tiff",
        as_attachment=True,
        download_name=row["filename"],
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/projects/<int:project_id>/rasters/<product>/preview")
def preview_project_raster(project_id, product):
    try:
        row = fetch_project_raster_data(project_id, product)
    except (DatabaseUnavailable, psycopg.Error) as error:
        return database_error(error)
    try:
        preview = raster_preview(bytes(row["data"]))
    except (RasterioError, ValueError) as error:
        app.logger.warning("No se pudo generar la vista previa de %s: %s", product, error)
        raise RequestError("No se pudo leer el {} guardado para mostrarlo.".format(product), 422)
    response = jsonify(preview=preview)
    response.headers["Cache-Control"] = "no-store"
    return response


def fetch_project_raster_data(project_id, product):
    product = product.upper()
    if product not in PRODUCTS:
        raise RequestError("El producto debe ser MDT02 o MDS02.", 404)
    with connect_database() as connection:
        row = connection.execute(
            """
            SELECT filename, data
            FROM public.proyecto_rasters
            WHERE proyecto_id = %s AND product = %s
            """,
            (project_id, product),
        ).fetchone()
    if not row:
        raise RequestError("Este proyecto no tiene un {} guardado.".format(product), 404)
    return row


@app.post("/api/projects")
def create_project():
    payload = validate_project_payload(request.get_json(silent=True))
    geometry = parse_geometry(json.dumps(payload["geometry"]))
    projected_centroid, area_m2, utm_zone, utm_epsg = project_centroid(geometry)

    try:
        with connect_database() as connection:
            row = connection.execute(
                """
                INSERT INTO public.proyectos (
                    name, geometry, area_m2, centroid_x, centroid_y,
                    utm_zone, utm_epsg
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING """ + PROJECT_COLUMNS,
                (
                    payload["name"],
                    Jsonb(geometry),
                    area_m2,
                    projected_centroid[0],
                    projected_centroid[1],
                    utm_zone,
                    utm_epsg,
                ),
            ).fetchone()
            save_project_rasters(connection, row["id"], payload["rasters"])
            rasters = fetch_project_rasters(connection, row["id"])
        return jsonify(project=serialize_project(row, rasters)), 201
    except (DatabaseUnavailable, psycopg.Error) as error:
        return database_error(error)


@app.put("/api/projects/<int:project_id>")
def update_project(project_id):
    payload = validate_project_payload(request.get_json(silent=True))
    geometry = parse_geometry(json.dumps(payload["geometry"]))
    projected_centroid, area_m2, utm_zone, utm_epsg = project_centroid(geometry)

    try:
        with connect_database() as connection:
            current = connection.execute(
                "SELECT geometry FROM public.proyectos WHERE id = %s FOR UPDATE",
                (project_id,),
            ).fetchone()
            if not current:
                return jsonify(error="No existe el proyecto que intentas actualizar."), 404

            row = connection.execute(
                """
                UPDATE public.proyectos
                SET name = %s, geometry = %s, area_m2 = %s,
                    centroid_x = %s, centroid_y = %s, utm_zone = %s,
                    utm_epsg = %s, updated_at = now()
                WHERE id = %s
                RETURNING """ + PROJECT_COLUMNS,
                (
                    payload["name"],
                    Jsonb(geometry),
                    area_m2,
                    projected_centroid[0],
                    projected_centroid[1],
                    utm_zone,
                    utm_epsg,
                    project_id,
                ),
            ).fetchone()

            # Un recorte guardado solo es válido para el polígono con el que se hizo:
            # si el polígono cambia, se descartan los que no se han vuelto a recortar.
            if not shape(current["geometry"]).equals(shape(geometry)):
                connection.execute(
                    """
                    DELETE FROM public.proyecto_rasters
                    WHERE proyecto_id = %s AND NOT (product = ANY(%s))
                    """,
                    (project_id, [raster["product"] for raster in payload["rasters"]]),
                )
            save_project_rasters(connection, project_id, payload["rasters"])
            rasters = fetch_project_rasters(connection, project_id)
        return jsonify(project=serialize_project(row, rasters))
    except (DatabaseUnavailable, psycopg.Error) as error:
        return database_error(error)


def save_project_rasters(connection, project_id, rasters):
    for raster in rasters:
        connection.execute(
            """
            INSERT INTO public.proyecto_rasters (
                proyecto_id, product, filename, size_bytes, metadata, data
            )
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (proyecto_id, product) DO UPDATE
            SET filename = EXCLUDED.filename, size_bytes = EXCLUDED.size_bytes,
                metadata = EXCLUDED.metadata, data = EXCLUDED.data,
                updated_at = now()
            """,
            (
                project_id,
                raster["product"],
                raster["filename"],
                len(raster["data"]),
                Jsonb(raster["metadata"]),
                raster["data"],
            ),
        )


def fetch_project_rasters(connection, project_id):
    return connection.execute(
        """
        SELECT product, filename, size_bytes, metadata, updated_at
        FROM public.proyecto_rasters
        WHERE proyecto_id = %s
        ORDER BY product
        """,
        (project_id,),
    ).fetchall()


def database_settings():
    required = {
        "host": os.environ.get("DRONES_PGHOST"),
        "user": os.environ.get("DRONES_PGUSER"),
        "password": os.environ.get("DRONES_PGPASSWORD"),
    }
    if any(not value for value in required.values()):
        raise DatabaseUnavailable(
            "Falta configurar DRONES_PGHOST, DRONES_PGUSER o DRONES_PGPASSWORD."
        )
    try:
        port = int(os.environ.get("DRONES_PGPORT", "5432"))
    except ValueError as error:
        raise DatabaseUnavailable("DRONES_PGPORT debe ser un puerto numérico.") from error
    if port < 1 or port > 65535:
        raise DatabaseUnavailable("DRONES_PGPORT debe estar entre 1 y 65535.")
    settings = {
        "host": required["host"],
        "port": port,
        "dbname": os.environ.get("DRONES_PGDATABASE", "DRONES"),
        "user": required["user"],
        "password": required["password"],
        "row_factory": dict_row,
        "connect_timeout": 5,
    }
    if os.environ.get("DRONES_PGSSLMODE"):
        settings["sslmode"] = os.environ["DRONES_PGSSLMODE"]
    return settings


def connect_database():
    try:
        return psycopg.connect(**database_settings())
    except DatabaseUnavailable:
        raise
    except psycopg.Error as error:
        raise DatabaseUnavailable("No se pudo conectar con PostgreSQL DRONES.") from error


def database_error(error):
    app.logger.error("No se pudo consultar la base de datos DRONES: %s", error)
    if isinstance(error, DatabaseUnavailable) and str(error).startswith("Falta configurar"):
        return jsonify(error=str(error)), 503
    return jsonify(
        error="No se pudo acceder a la base de datos DRONES. Comprueba la conexión, "
        "el usuario y que se hayan aplicado las migraciones de database/."
    ), 503


def validate_project_payload(payload):
    if not isinstance(payload, dict):
        raise RequestError("El proyecto debe enviarse como un objeto JSON.")
    name = payload.get("name")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 120:
        raise RequestError("Introduce un nombre de proyecto de 1 a 120 caracteres.")
    geometry = payload.get("geometry")
    if not isinstance(geometry, dict):
        raise RequestError("El proyecto necesita un polígono GeoJSON.")
    return {
        "name": name.strip(),
        "geometry": geometry,
        "rasters": validate_project_rasters(payload.get("rasters", [])),
    }


def validate_project_rasters(rasters):
    if not isinstance(rasters, list) or len(rasters) > len(PRODUCTS):
        raise RequestError("La lista de GeoTIFF del proyecto no es válida.")

    validated = []
    for raster in rasters:
        if not isinstance(raster, dict):
            raise RequestError("La lista de GeoTIFF del proyecto no es válida.")
        product = raster.get("product")
        if product not in PRODUCTS or any(item["product"] == product for item in validated):
            raise RequestError("Cada proyecto admite un único GeoTIFF MDT02 y otro MDS02.")

        data_text = raster.get("data")
        max_mb = MAX_PROJECT_RASTER_BYTES // (1024 * 1024)
        if not isinstance(data_text, str) or len(data_text) > (MAX_PROJECT_RASTER_BYTES + 2) // 3 * 4:
            raise RequestError(
                "El {} recortado supera {} MB y no se puede guardar en el proyecto.".format(
                    product, max_mb
                ),
                413,
            )
        try:
            data = base64.b64decode(data_text, validate=True)
        except (binascii.Error, ValueError):
            raise RequestError("El {} recortado no tiene un formato válido.".format(product))
        if not data:
            raise RequestError("El {} recortado está vacío.".format(product))

        try:
            with MemoryFile(data) as memory_file, memory_file.open() as dataset:
                tagged_product = dataset.tags().get("product")
        except RasterioError:
            raise RequestError("El {} recortado no es un GeoTIFF válido.".format(product))
        if tagged_product != product:
            raise RequestError(
                "El GeoTIFF enviado como {} no es un recorte de ese producto.".format(product)
            )

        metadata = raster.get("metadata")
        metadata = dict(metadata) if isinstance(metadata, dict) else {}
        metadata.update(product=product, filename=PRODUCTS[product]["filename"])
        validated.append(
            {
                "product": product,
                "filename": PRODUCTS[product]["filename"],
                "metadata": metadata,
                "data": data,
            }
        )
    return validated


def project_centroid(geometry_data):
    polygon = shape(geometry_data)
    longitude = polygon.centroid.x
    utm_zone = min(60, max(1, math.floor((longitude + 180) / 6) + 1))
    utm_epsg = 25800 + utm_zone
    projected = shape(
        transform_geom(
            "EPSG:4326",
            "EPSG:{}".format(utm_epsg),
            geometry_data,
            precision=8,
        )
    )
    if projected.is_empty or not projected.is_valid or projected.area <= 0:
        raise RequestError("No se pudo proyectar el área del proyecto a ETRS89 / UTM.")
    centroid = projected.centroid
    return (centroid.x, centroid.y), projected.area, utm_zone, utm_epsg


def serialize_project(row, rasters=None):
    project = serialize_timestamps(row)
    if rasters is not None:
        project["rasters"] = [serialize_timestamps(raster) for raster in rasters]
    return project


def serialize_timestamps(row):
    item = dict(row)
    for field in ("created_at", "updated_at"):
        if field in item and isinstance(item[field], datetime):
            item[field] = item[field].astimezone(timezone.utc).isoformat()
    return item


def parse_geometry(geometry_text):
    if len(geometry_text) > 2_000_000:
        raise RequestError("El GeoJSON del polígono supera el tamaño permitido.")
    try:
        geometry_data = json.loads(geometry_text)
        if not isinstance(geometry_data, dict) or geometry_data.get("type") not in {
            "Polygon",
            "MultiPolygon",
        }:
            raise ValueError("El área debe ser un polígono o multipolígono.")
        geometry = shape(geometry_data)
    except (json.JSONDecodeError, KeyError, IndexError, TypeError, ValueError, ShapelyError) as error:
        raise RequestError("El polígono no tiene un formato GeoJSON válido: {}.".format(error))

    if geometry.is_empty or not geometry.is_valid or geometry.area <= 0:
        raise RequestError("El polígono está vacío o no es válido; vuelve a dibujarlo.")
    if count_vertices(geometry_data.get("coordinates", [])) > 10000:
        raise RequestError("El polígono tiene demasiados vértices (máximo 10.000).")

    min_x, min_y, max_x, max_y = geometry.bounds
    if not all(math.isfinite(value) for value in (min_x, min_y, max_x, max_y)):
        raise RequestError("El polígono contiene coordenadas no válidas.")
    if min_x < -180 or max_x > 180 or min_y < -90 or max_y > 90:
        raise RequestError("Las coordenadas del polígono deben estar en longitud/latitud WGS84.")
    return mapping(geometry)


def count_vertices(coordinates):
    if not isinstance(coordinates, (list, tuple)):
        return 0
    if coordinates and all(isinstance(value, (int, float)) for value in coordinates):
        return 1
    return sum(count_vertices(value) for value in coordinates)


def save_uploaded_files(files, work_dir):
    paths = []
    source_names = []
    for index, file_storage in enumerate(files, start=1):
        filename = file_storage.filename or ""
        if Path(filename).suffix.lower() not in {".tif", ".tiff"}:
            raise RequestError("Solo se aceptan archivos GeoTIFF (.tif o .tiff).")
        target = work_dir / "source_{:02d}.tif".format(index)
        file_storage.save(str(target))
        if target.stat().st_size == 0:
            raise RequestError("El archivo {} está vacío.".format(filename))
        paths.append(target)
        source_names.append(Path(filename).name[:255])
    return paths, source_names


def create_clipped_raster(source_paths, geometry_wgs84, work_dir, product, source_names):
    with rasterio.Env():
        datasets = []
        try:
            for path in source_paths:
                try:
                    dataset = rasterio.open(path)
                except RasterioError as error:
                    raise RequestError(
                        "Uno de los archivos seleccionados no es un GeoTIFF legible: {}.".format(error),
                        422,
                    )
                datasets.append(dataset)

            first = datasets[0]
            if first.crs is None or not first.crs.is_projected:
                raise RequestError("El raster debe tener un sistema de coordenadas proyectado.")
            if first.crs.linear_units != "metre":
                raise RequestError("El raster debe estar proyectado en metros (UTM en España).")

            expected_transform = first.transform
            if abs(abs(expected_transform.a) - 2) > 0.2 or abs(abs(expected_transform.e) - 2) > 0.2:
                raise RequestError(
                    "El raster seleccionado no parece {}: se espera una resolución cercana a 2 m.".format(
                        product
                    )
                )

            for dataset in datasets:
                if dataset.crs != first.crs:
                    raise RequestError(
                        "Los GeoTIFF seleccionados usan distintos sistemas de coordenadas; "
                        "elige hojas de la misma zona UTM."
                    )
                if dataset.count != first.count or dataset.dtypes != first.dtypes:
                    raise RequestError(
                        "Los GeoTIFF deben tener el mismo número de bandas y tipo de dato."
                    )
                if (
                    abs(abs(dataset.transform.a) - abs(expected_transform.a)) > 0.01
                    or abs(abs(dataset.transform.e) - abs(expected_transform.e)) > 0.01
                ):
                    raise RequestError("Las resoluciones de los GeoTIFF seleccionados no coinciden.")

            projected_geometry_data = transform_geom(
                "EPSG:4326",
                first.crs,
                geometry_wgs84,
                precision=8,
            )
            projected_geometry = shape(projected_geometry_data)
            if projected_geometry.is_empty or not projected_geometry.is_valid:
                raise RequestError(
                    "No se pudo proyectar el polígono al sistema de coordenadas del raster."
                )

            area_km2 = projected_geometry.area / 1_000_000
            if area_km2 > MAX_AREA_KM2:
                raise RequestError(
                    "El polígono ocupa {:.1f} km²; el límite de este visor es {} km². "
                    "Reduce el área o ajusta MDT02_MAX_AREA_KM2.".format(area_km2, MAX_AREA_KM2),
                    413,
                )

            raster_coverage = unary_union(
                [box(*dataset.bounds) for dataset in datasets]
            )
            uncovered_area = projected_geometry.difference(raster_coverage).area
            if uncovered_area > max(1, projected_geometry.area * 0.0001):
                raise RequestError(
                    "Los archivos no cubren todo el polígono. Descarga y selecciona todas "
                    "las hojas {} que lo intersectan.".format(product),
                    422,
                )

            merged_path = work_dir / "mosaic.tif"
            merge(
                datasets,
                bounds=projected_geometry.bounds,
                nodata=first.nodata,
                dtype=first.dtypes[0],
                dst_path=str(merged_path),
            )

            with rasterio.open(merged_path) as mosaic:
                nodata = mosaic.nodata
                if nodata is None:
                    nodata = default_nodata(mosaic.dtypes[0])
                clipped, transform = mask(
                    mosaic,
                    [projected_geometry_data],
                    crop=True,
                    nodata=nodata,
                    filled=True,
                    all_touched=False,
                )
                if clipped.size == 0 or clipped.shape[1] == 0 or clipped.shape[2] == 0:
                    raise RequestError(
                        "El polígono no se solapa con los GeoTIFF seleccionados.",
                        422,
                    )

                profile = mosaic.profile.copy()
                profile.update(
                    driver="GTiff",
                    height=clipped.shape[1],
                    width=clipped.shape[2],
                    transform=transform,
                    nodata=nodata,
                    compress="deflate",
                    BIGTIFF="IF_SAFER",
                )
                output_name = PRODUCTS[product]["filename"]
                output_path = work_dir / output_name
                with rasterio.open(output_path, "w", **profile) as output:
                    output.write(clipped)
                    output.update_tags(
                        source="CNIG - IGN",
                        product=product,
                        license="CC-BY 4.0",
                        area_km2="{:.4f}".format(area_km2),
                    )

            bounds = rasterio.transform.array_bounds(
                clipped.shape[1], clipped.shape[2], transform
            )
            output_metadata = {
                "filename": output_name,
                "product": product,
                "crs": first.crs.to_string(),
                "resolution": [abs(transform.a), abs(transform.e)],
                "width": clipped.shape[2],
                "height": clipped.shape[1],
                "bounds": list(bounds),
                "source_files": source_names,
                "processed_at": datetime.now(timezone.utc).isoformat(),
            }
            return output_path, output_name, output_metadata
        finally:
            for dataset in datasets:
                dataset.close()


def default_nodata(dtype):
    data_type = np.dtype(dtype)
    if np.issubdtype(data_type, np.floating):
        return -9999.0
    limits = np.iinfo(data_type)
    return int(limits.min if np.issubdtype(data_type, np.signedinteger) else limits.max)


@app.errorhandler(RequestError)
def handle_request_error(error):
    return jsonify(error=str(error)), error.status_code


@app.errorhandler(413)
def handle_request_too_large(_error):
    return jsonify(
        error="La carga supera el límite de {} MB.".format(MAX_UPLOAD_BYTES // (1024 * 1024))
    ), 413


@app.errorhandler(500)
def handle_internal_error(error):
    app.logger.error("Error interno en la petición: %s", error)
    return jsonify(error="Error interno del procesador. Consulta la consola del servidor."), 500


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT, debug=False)
