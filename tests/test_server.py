import base64
import io
import json
import os
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from server import app, project_centroid

import numpy as np
import rasterio
from affine import Affine
from pyproj import Transformer
from rasterio.io import MemoryFile


class ClipEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        transformer = Transformer.from_crs("EPSG:25830", "EPSG:4326", always_xy=True)
        projected_ring = [
            (440002, 4470000),
            (440014, 4470000),
            (440014, 4470006),
            (440002, 4470006),
            (440002, 4470000),
        ]
        geographic_ring = [transformer.transform(x, y) for x, y in projected_ring]
        cls.geometry = {
            "type": "Polygon",
            "coordinates": [geographic_ring],
        }

    def setUp(self):
        self.client = app.test_client()

    def make_raster(self, x_origin, value):
        buffer = io.BytesIO()
        profile = {
            "driver": "GTiff",
            "height": 4,
            "width": 4,
            "count": 1,
            "dtype": "float32",
            "crs": "EPSG:25830",
            "transform": Affine(2, 0, x_origin, 0, -2, 4470008),
            "nodata": -9999,
        }
        with rasterio.open(buffer, "w", **profile) as dataset:
            dataset.write(np.full((1, 4, 4), value, dtype=np.float32))
        buffer.seek(0)
        return buffer

    def full_coverage(self, value, prefix):
        return [
            (self.make_raster(440000, value), prefix + "_west.tif"),
            (self.make_raster(440008, value + 50), prefix + "_east.tif"),
        ]

    def post_clip(self, rasters_by_product, geometry=None, headers=None):
        data = {"geometry": json.dumps(geometry or self.geometry)}
        for product, rasters in rasters_by_product.items():
            data["rasters_" + product] = rasters
        return self.client.post(
            "/api/clip",
            data=data,
            content_type="multipart/form-data",
            headers=headers,
        )

    def clipped_rasters(self, response):
        self.assertEqual(response.status_code, 200, response.get_json())
        return {raster["product"]: raster for raster in response.get_json()["rasters"]}

    def test_health_endpoint(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "ok")

    def test_rejects_external_origin(self):
        response = self.post_clip(
            {"MDT02": [(self.make_raster(440000, 100), "tile.tif")]},
            headers={"Origin": "https://attacker.example"},
        )
        self.assertEqual(response.status_code, 403)

    def test_rejects_invalid_polygon(self):
        response = self.post_clip(
            {"MDT02": [(self.make_raster(440000, 100), "tile.tif")]},
            geometry={"type": "Polygon", "coordinates": []},
        )
        self.assertEqual(response.status_code, 400)

    def test_requires_at_least_one_product(self):
        response = self.post_clip({})
        self.assertEqual(response.status_code, 400)
        self.assertIn("MDT02, MDS02 o ambos", response.get_json()["error"])

    def test_clips_mdt02_and_mds02_with_the_same_polygon(self):
        rasters = self.clipped_rasters(
            self.post_clip(
                {
                    "MDT02": self.full_coverage(100, "MDT02"),
                    "MDS02": self.full_coverage(150, "MDS02"),
                }
            )
        )
        self.assertEqual(set(rasters), {"MDT02", "MDS02"})

        for product, expected_values in (("MDT02", {100.0, 150.0}), ("MDS02", {150.0, 200.0})):
            raster = rasters[product]
            self.assertEqual(raster["filename"], product + "_recortado.tif")
            self.assertEqual(
                raster["metadata"]["source_files"],
                [product + "_west.tif", product + "_east.tif"],
            )
            data = base64.b64decode(raster["data"])
            self.assertEqual(raster["size_bytes"], len(data))
            with MemoryFile(data) as memory_file, memory_file.open() as result:
                self.assertEqual(result.crs.to_epsg(), 25830)
                self.assertEqual(result.res, (2.0, 2.0))
                values = result.read(1)
                self.assertEqual(values.shape, (3, 6))
                self.assertEqual(set(np.unique(values)), expected_values)
                self.assertEqual(result.tags()["product"], product)

    def test_clip_includes_web_mercator_preview_with_elevation_range(self):
        rasters = self.clipped_rasters(
            self.post_clip(
                {
                    "MDT02": self.full_coverage(100, "MDT02"),
                    "MDS02": self.full_coverage(150, "MDS02"),
                }
            )
        )
        preview = rasters["MDS02"]["preview"]
        grid = np.frombuffer(base64.b64decode(preview["data"]), dtype="<f4")
        self.assertEqual(grid.size, preview["width"] * preview["height"])
        self.assertGreaterEqual(preview["min"], 150)
        self.assertLessEqual(preview["max"], 200)
        self.assertAlmostEqual(preview["cell_size"], 2, delta=0.5)

        (south, west), (north, east) = preview["bounds"]
        ring = self.geometry["coordinates"][0]
        self.assertAlmostEqual(west, min(point[0] for point in ring), delta=0.0001)
        self.assertAlmostEqual(north, max(point[1] for point in ring), delta=0.0001)
        self.assertLess(south, north)
        self.assertLess(west, east)

    def test_preview_endpoint_reads_saved_raster(self):
        rasters = self.clipped_rasters(self.post_clip({"MDT02": self.full_coverage(100, "MDT02")}))
        connection = MagicMock()
        connection.__enter__.return_value.execute.return_value.fetchone.return_value = {
            "filename": "MDT02_recortado.tif",
            "data": base64.b64decode(rasters["MDT02"]["data"]),
        }
        with patch("server.connect_database", return_value=connection):
            response = self.client.get("/api/projects/12/rasters/MDT02/preview")
        self.assertEqual(response.status_code, 200, response.get_json())
        preview = response.get_json()["preview"]
        self.assertEqual(preview["min"], rasters["MDT02"]["preview"]["min"])
        self.assertEqual(preview["max"], rasters["MDT02"]["preview"]["max"])

    def test_preview_endpoint_reports_missing_raster(self):
        connection = MagicMock()
        connection.__enter__.return_value.execute.return_value.fetchone.return_value = None
        with patch("server.connect_database", return_value=connection):
            response = self.client.get("/api/projects/12/rasters/MDS02/preview")
        self.assertEqual(response.status_code, 404)

    def test_clips_a_single_product(self):
        rasters = self.clipped_rasters(self.post_clip({"MDS02": self.full_coverage(150, "MDS02")}))
        self.assertEqual(set(rasters), {"MDS02"})

    def test_rejects_incomplete_tile_coverage(self):
        response = self.post_clip(
            {
                "MDT02": [(self.make_raster(440000, 100), "west.tif")],
                "MDS02": self.full_coverage(150, "MDS02"),
            }
        )
        self.assertEqual(response.status_code, 422)
        self.assertIn("hojas MDT02", response.get_json()["error"])

    def test_project_centroid_is_derived_in_etrs89_utm(self):
        centroid, area, zone, epsg = project_centroid(self.geometry)
        self.assertEqual(zone, 30)
        self.assertEqual(epsg, 25830)
        self.assertAlmostEqual(centroid[0], 440008, delta=0.5)
        self.assertAlmostEqual(centroid[1], 4470003, delta=0.5)
        self.assertGreater(area, 0)

    def test_projects_api_reports_missing_database_configuration(self):
        with patch.dict(
            os.environ,
            {
                "DRONES_PGHOST": "",
                "DRONES_PGUSER": "",
                "DRONES_PGPASSWORD": "",
            },
        ):
            response = self.client.get("/api/projects")
        self.assertEqual(response.status_code, 503)
        self.assertIn("DRONES_PGHOST", response.get_json()["error"])

    def mock_connection(self, raster_rows):
        project_row = {
            "id": 12,
            "name": "Inspección norte",
            "geometry": self.geometry,
            "area_m2": 72,
            "centroid_x": 440008,
            "centroid_y": 4470003,
            "utm_zone": 30,
            "utm_epsg": 25830,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        }
        connection = MagicMock()
        cursor = connection.__enter__.return_value.execute.return_value
        cursor.fetchone.return_value = project_row
        cursor.fetchall.return_value = raster_rows
        return connection

    def test_creates_project_with_both_clipped_rasters(self):
        rasters = self.clipped_rasters(
            self.post_clip(
                {
                    "MDT02": self.full_coverage(100, "MDT02"),
                    "MDS02": self.full_coverage(150, "MDS02"),
                }
            )
        )
        raster_rows = [
            {
                "product": product,
                "filename": rasters[product]["filename"],
                "size_bytes": rasters[product]["size_bytes"],
                "metadata": rasters[product]["metadata"],
                "updated_at": datetime.now(timezone.utc),
            }
            for product in ("MDS02", "MDT02")
        ]
        connection = self.mock_connection(raster_rows)

        with patch("server.connect_database", return_value=connection):
            response = self.client.post(
                "/api/projects",
                json={
                    "name": "Inspección norte",
                    "geometry": self.geometry,
                    "rasters": [
                        {
                            "product": product,
                            "metadata": rasters[product]["metadata"],
                            "data": rasters[product]["data"],
                        }
                        for product in ("MDT02", "MDS02")
                    ],
                },
            )

        self.assertEqual(response.status_code, 201, response.get_json())
        project = response.get_json()["project"]
        self.assertEqual(project["id"], 12)
        self.assertEqual([raster["product"] for raster in project["rasters"]], ["MDS02", "MDT02"])

        execute = connection.__enter__.return_value.execute
        stored = {
            call.args[1][1]: call.args[1][5]
            for call in execute.call_args_list
            if "INSERT INTO public.proyecto_rasters" in call.args[0]
        }
        self.assertEqual(set(stored), {"MDT02", "MDS02"})
        self.assertEqual(stored["MDT02"], base64.b64decode(rasters["MDT02"]["data"]))

    def test_rejects_raster_saved_under_the_wrong_product(self):
        rasters = self.clipped_rasters(self.post_clip({"MDT02": self.full_coverage(100, "MDT02")}))
        with patch("server.connect_database") as connect:
            response = self.client.post(
                "/api/projects",
                json={
                    "name": "Mezclado",
                    "geometry": self.geometry,
                    "rasters": [{"product": "MDS02", "data": rasters["MDT02"]["data"]}],
                },
            )
        self.assertEqual(response.status_code, 400)
        self.assertIn("no es un recorte de ese producto", response.get_json()["error"])
        connect.assert_not_called()

    def test_rejects_raster_that_is_not_a_geotiff(self):
        response = self.client.post(
            "/api/projects",
            json={
                "name": "Roto",
                "geometry": self.geometry,
                "rasters": [
                    {"product": "MDT02", "data": base64.b64encode(b"no soy un tif").decode()}
                ],
            },
        )
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
