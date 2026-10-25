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

    def post_clip(self, rasters, geometry=None, headers=None, product="MDT02"):
        data = {
            "geometry": json.dumps(geometry or self.geometry),
            "product": product,
            "rasters": rasters,
        }
        return self.client.post(
            "/api/clip",
            data=data,
            content_type="multipart/form-data",
            headers=headers,
        )

    def test_health_endpoint(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "ok")

    def test_rejects_external_origin(self):
        response = self.post_clip(
            [(self.make_raster(440000, 100), "tile.tif")],
            headers={"Origin": "https://attacker.example"},
        )
        self.assertEqual(response.status_code, 403)

    def test_rejects_invalid_polygon(self):
        response = self.post_clip(
            [(self.make_raster(440000, 100), "tile.tif")],
            geometry={"type": "Polygon", "coordinates": []},
        )
        self.assertEqual(response.status_code, 400)

    def test_supports_mds02_and_returns_output_metadata(self):
        response = self.post_clip(
            [
                (self.make_raster(440000, 150), "MDS02_west.tif"),
                (self.make_raster(440008, 175), "MDS02_east.tif"),
            ],
            product="MDS02",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Content-Disposition"].split("filename=")[-1], "MDS02_recortado.tif")
        metadata = json.loads(response.headers["X-Raster-Metadata"])
        self.assertEqual(metadata["product"], "MDS02")
        self.assertEqual(
            metadata["source_files"],
            ["MDS02_west.tif", "MDS02_east.tif"],
        )
        output_data = response.data
        response.close()
        with MemoryFile(output_data) as memory_file:
            with memory_file.open() as result:
                self.assertEqual(result.tags()["product"], "MDS02")

    def test_clips_a_mosaic_at_source_resolution_and_crs(self):
        response = self.post_clip(
            [
                (self.make_raster(440000, 100), "west.tif"),
                (self.make_raster(440008, 200), "east.tif"),
            ]
        )
        self.assertEqual(response.status_code, 200)
        output_data = response.data
        response.close()

        with MemoryFile(output_data) as memory_file:
            with memory_file.open() as result:
                self.assertEqual(result.crs.to_epsg(), 25830)
                self.assertEqual(result.res, (2.0, 2.0))
                values = result.read(1)
                self.assertEqual(values.shape, (3, 6))
                self.assertEqual(set(np.unique(values)), {100.0, 200.0})
                self.assertEqual(result.tags()["product"], "MDT02")

    def test_rejects_incomplete_tile_coverage(self):
        response = self.post_clip([(self.make_raster(440000, 100), "west.tif")])
        self.assertEqual(response.status_code, 422)
        self.assertIn("no cubren todo el polígono", response.get_json()["error"])

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

    def test_creates_project_record(self):
        project_row = {
            "id": 12,
            "name": "Inspección norte",
            "product": "MDS02",
            "geometry": self.geometry,
            "area_m2": 72,
            "centroid_x": 440008,
            "centroid_y": 4470003,
            "utm_zone": 30,
            "utm_epsg": 25830,
            "source_files": ["MDS02_tile.tif"],
            "output_filename": "MDS02_recortado.tif",
            "output_metadata": {"filename": "MDS02_recortado.tif", "product": "MDS02"},
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        }
        connection = MagicMock()
        connection.__enter__.return_value.execute.return_value.fetchone.return_value = project_row

        with patch("server.connect_database", return_value=connection):
            response = self.client.post(
                "/api/projects",
                json={
                    "name": "Inspección norte",
                    "product": "MDS02",
                    "geometry": self.geometry,
                    "source_files": ["MDS02_tile.tif"],
                    "output_metadata": {
                        "filename": "MDS02_recortado.tif",
                        "product": "MDS02",
                    },
                },
            )

        self.assertEqual(response.status_code, 201, response.get_json())
        self.assertEqual(response.get_json()["project"]["id"], 12)
        self.assertEqual(response.get_json()["project"]["product"], "MDS02")


if __name__ == "__main__":
    unittest.main()
