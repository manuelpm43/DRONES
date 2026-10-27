"use strict";

const PRODUCTS = {
    MDT02: {
        name: "Modelo Digital del Terreno",
        filename: "MDT02_recortado.tif"
    },
    MDS02: {
        name: "Modelo Digital de Superficies",
        filename: "MDS02_recortado.tif"
    }
};
const PRODUCT_CODES = Object.keys(PRODUCTS);
const EMPTY_FILE_SUMMARY = "Puedes seleccionar varias hojas (.tif, .tiff)";
// Rampa hipsométrica: de la cota mínima (verde) a la máxima (blanco).
const ELEVATION_RAMP = [
    [0, [39, 110, 64]],
    [0.25, [120, 170, 80]],
    [0.5, [235, 220, 130]],
    [0.75, [170, 110, 60]],
    [1, [245, 240, 235]]
];
// Luz del sombreado de relieve: desde el noroeste a 45° de altura (este, norte, arriba).
const LIGHT = [-0.5, 0.5, Math.SQRT1_2];
// Color de las celdas en colisión con cada modelo.
const COLLISION_COLORS = {
    MDT02: [200, 35, 35],
    MDS02: [245, 130, 20]
};
const EARTH_RADIUS_MERCATOR = 6378137;

const map = L.map("map", {
    zoomControl: false,
    center: [40.25, -3.7],
    zoom: 6
});

L.control.zoom({ position: "topright" }).addTo(map);

L.tileLayer(
    "https://www.ign.es/wmts/pnoa-ma?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=OI.OrthoimageCoverage&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg",
    {
        attribution: '&copy; <a href="https://www.ign.es/">IGN</a> - PNOA',
        maxZoom: 19,
        maxNativeZoom: 19
    }
).addTo(map);

// Los modelos van por debajo del polígono dibujado (overlayPane, z-index 400).
map.createPane("modelos");
map.getPane("modelos").style.zIndex = 350;
map.createPane("colisiones");
map.getPane("colisiones").style.zIndex = 360;

const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

const drawControl = new L.Draw.Polygon(map, {
    allowIntersection: false,
    showArea: false,
    shapeOptions: {
        color: "#087e8b",
        weight: 3,
        fillColor: "#21a7a0",
        fillOpacity: 0.2
    },
    drawError: {
        color: "#ab3f3f",
        message: "El polígono no puede cruzarse consigo mismo."
    }
});

map.on(L.Draw.Event.DRAWSTART, function () {
    map.doubleClickZoom.disable();
});
map.on(L.Draw.Event.DRAWSTOP, function () {
    map.doubleClickZoom.enable();
});

const drawButton = document.getElementById("draw-button");
const exportButton = document.getElementById("export-button");
const clearButton = document.getElementById("clear-button");
const clipButton = document.getElementById("clip-button");
const rasterInputs = {};
const fileSummaries = {};
PRODUCT_CODES.forEach(function (product) {
    rasterInputs[product] = document.getElementById("raster-files-" + product);
    fileSummaries[product] = document.getElementById("file-summary-" + product);
});
const areaValue = document.getElementById("area-value");
const vertexValue = document.getElementById("vertex-value");
const centroidPanel = document.getElementById("centroid-panel");
const centroidX = document.getElementById("centroid-x");
const centroidY = document.getElementById("centroid-y");
const centroidCrs = document.getElementById("centroid-crs");
const copyCentroidButton = document.getElementById("copy-centroid-button");
const projectNameInput = document.getElementById("project-name");
const projectList = document.getElementById("project-list");
const saveProjectButton = document.getElementById("save-project-button");
const openProjectButton = document.getElementById("open-project-button");
const newProjectButton = document.getElementById("new-project-button");
const projectsStatus = document.getElementById("projects-status");
const selectionBadge = document.getElementById("selection-badge");
const statusMessage = document.getElementById("status-message");
const progressWrap = document.getElementById("progress-wrap");
const progressBar = document.getElementById("progress-bar");
const progressLabel = document.getElementById("progress-label");
const rasterResults = document.getElementById("raster-results");
const rasterList = document.getElementById("raster-list");
const modelPanel = document.getElementById("model-panel");
const modelButtons = Array.from(modelPanel.querySelectorAll("[data-model]"));
const takeoffButton = document.getElementById("takeoff-button");
const takeoffInfo = document.getElementById("takeoff-info");
const takeoffCoords = document.getElementById("takeoff-coords");
const takeoffElevationValue = document.getElementById("takeoff-elevation");
const flightHeightInput = document.getElementById("flight-height");
const safetyMarginInput = document.getElementById("safety-margin");
const collisionButton = document.getElementById("collision-button");
const flightStatus = document.getElementById("flight-status");
const collisionResults = document.getElementById("collision-results");
const elevationLegend = document.getElementById("elevation-legend");
const legendMin = document.getElementById("legend-min");
const legendMid = document.getElementById("legend-mid");
const legendMax = document.getElementById("legend-max");
document.getElementById("legend-ramp").style.background =
    "linear-gradient(to right, " + ELEVATION_RAMP.map(function (stop) {
        return "rgb(" + stop[1].join(",") + ") " + stop[0] * 100 + "%";
    }).join(", ") + ")";

let selectedPolygon = null;
let isClipping = false;
let centroidCoordinates = null;
let activeProjectId = null;
let savedProjects = [];
// Recortes hechos en esta sesión que aún no se han guardado en el proyecto.
let clippedRasters = {};
// Recortes guardados en la base para el proyecto abierto.
let savedRasters = {};
// El polígono cambió después de abrir el proyecto: los recortes guardados ya no le corresponden.
let savedRastersStale = false;
// Vistas previas (cotas en Web Mercator) de los recortes guardados, por producto.
let savedPreviews = {};
// Modelo pintado en el mapa: "MDT02", "MDS02" o null (ninguno).
let visibleModel = "MDT02";
const modelLayers = {};
let shownPreviews = {};
// Análisis de vuelo.
let pickingTakeoff = false;
let takeoff = null;
let takeoffMarker = null;
let collisionLayers = [];
let collisionShown = false;

drawButton.addEventListener("click", function () {
    drawControl.enable();
    setStatus("Marca los vértices y vuelve a hacer clic en el primero para cerrar el polígono.");
});

map.on(L.Draw.Event.CREATED, function (event) {
    drawnItems.clearLayers();
    selectedPolygon = event.layer;
    discardClippedRasters();
    resetRasterInputs();
    drawnItems.addLayer(selectedPolygon);
    map.fitBounds(selectedPolygon.getBounds(), { padding: [30, 30] });
    updateSelection();
    setStatus("Polígono guardado. Descarga las hojas MDT02 y MDS02 que cubran esta zona.");
});

clearButton.addEventListener("click", function () {
    drawnItems.clearLayers();
    selectedPolygon = null;
    centroidCoordinates = null;
    discardClippedRasters();
    updateSelection();
    setStatus("Polígono borrado. Dibuja una nueva área para continuar.");
});

projectNameInput.addEventListener("input", updateSelection);
saveProjectButton.addEventListener("click", saveProject);
openProjectButton.addEventListener("click", openSelectedProject);
newProjectButton.addEventListener("click", startNewProject);
projectList.addEventListener("change", function () {
    openProjectButton.disabled = !projectList.value;
});

exportButton.addEventListener("click", function () {
    if (!selectedPolygon) {
        return;
    }

    const feature = selectedPolygon.toGeoJSON();
    const collection = {
        type: "FeatureCollection",
        name: "area_vuelo",
        features: [feature]
    };
    downloadBlob(
        new Blob([JSON.stringify(collection, null, 2)], {
            type: "application/geo+json;charset=utf-8"
        }),
        "area_vuelo.geojson"
    );
});

copyCentroidButton.addEventListener("click", async function () {
    if (!centroidCoordinates) {
        return;
    }

    try {
        await navigator.clipboard.writeText(
            centroidCoordinates.x + ", " + centroidCoordinates.y
        );
        copyCentroidButton.textContent = "Coordenadas copiadas";
        window.setTimeout(function () {
            copyCentroidButton.textContent = "Copiar coordenadas X, Y";
        }, 1800);
    } catch (error) {
        setStatus("No se pudieron copiar las coordenadas. Selecciónalas y cópialas manualmente.", "error");
    }
});

PRODUCT_CODES.forEach(function (product) {
    rasterInputs[product].addEventListener("change", function () {
        const files = selectedFiles(product);
        fileSummaries[product].textContent = files.length
            ? files.length + (files.length === 1 ? " GeoTIFF seleccionado" : " GeoTIFF seleccionados")
            : EMPTY_FILE_SUMMARY;
        updateSelection();
        if (files.length) {
            setStatus("Comprueba que has seleccionado todas las hojas " + product + " que cubren el polígono.");
        }
    });
});

clipButton.addEventListener("click", clipSelectedRasters);

modelButtons.forEach(function (button) {
    button.addEventListener("click", function () {
        visibleModel = button.dataset.model || null;
        refreshModelLayers();
    });
});

takeoffButton.addEventListener("click", function () {
    pickingTakeoff = true;
    map.getContainer().classList.add("map-picking");
    setFlightStatus("Haz clic en el mapa, dentro de la zona recortada, en el punto de despegue.");
});

map.on("click", function (event) {
    if (!pickingTakeoff || drawControl.enabled()) {
        return;
    }
    pickingTakeoff = false;
    map.getContainer().classList.remove("map-picking");
    setTakeoff(event.latlng);
});

collisionButton.addEventListener("click", runCollisionCheck);
[flightHeightInput, safetyMarginInput].forEach(function (input) {
    input.addEventListener("input", function () {
        if (collisionShown) {
            runCollisionCheck();
        }
    });
});

loadProjects();

function selectedFiles(product) {
    return Array.from(rasterInputs[product].files || []);
}

function productsWithFiles() {
    return PRODUCT_CODES.filter(function (product) {
        return selectedFiles(product).length > 0;
    });
}

function resetRasterInputs() {
    PRODUCT_CODES.forEach(function (product) {
        rasterInputs[product].value = "";
        fileSummaries[product].textContent = EMPTY_FILE_SUMMARY;
    });
}

function discardClippedRasters() {
    clippedRasters = {};
    if (Object.keys(savedRasters).length) {
        savedRastersStale = true;
    }
    renderRasters();
}

function updateSelection() {
    const hasPolygon = Boolean(selectedPolygon);
    const products = productsWithFiles();

    exportButton.disabled = !hasPolygon || isClipping;
    clearButton.disabled = !hasPolygon || isClipping;
    drawButton.disabled = isClipping;
    clipButton.disabled = !hasPolygon || products.length === 0 || isClipping;
    clipButton.textContent = "Recortar " + (products.length === 1 ? products[0] : "MDT02 y MDS02");
    PRODUCT_CODES.forEach(function (product) {
        rasterInputs[product].disabled = isClipping;
    });
    saveProjectButton.disabled = !hasPolygon || !projectNameInput.value.trim() || isClipping;
    saveProjectButton.textContent = activeProjectId ? "Actualizar proyecto" : "Guardar proyecto";

    if (!hasPolygon) {
        areaValue.textContent = "—";
        vertexValue.textContent = "—";
        centroidPanel.hidden = true;
        centroidCoordinates = null;
        selectionBadge.textContent = "Sin definir";
        selectionBadge.className = "badge badge-muted";
        return;
    }

    const coordinates = selectedPolygon.getLatLngs()[0];
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    const isClosed =
        first.lat === last.lat &&
        first.lng === last.lng;
    const vertices = coordinates.length - (isClosed ? 1 : 0);
    areaValue.textContent = formatArea(geodesicArea(coordinates));
    vertexValue.textContent = String(vertices);
    centroidCoordinates = etrs89UtmCentroid(coordinates);
    centroidX.textContent = centroidCoordinates.x;
    centroidY.textContent = centroidCoordinates.y;
    centroidCrs.textContent = centroidCoordinates.crs;
    centroidPanel.hidden = false;
    selectionBadge.textContent = "Polígono listo";
    selectionBadge.className = "badge badge-active";
}

function renderRasters() {
    rasterList.replaceChildren();

    PRODUCT_CODES.forEach(function (product) {
        const clipped = clippedRasters[product];
        const saved = savedRasters[product];
        if (!clipped && !saved) {
            return;
        }

        const raster = clipped || saved;
        const item = document.createElement("li");
        item.className = "raster-item";

        const text = document.createElement("span");
        const title = document.createElement("strong");
        title.textContent = raster.filename;
        const detail = document.createElement("small");
        let state = "";
        if (clipped) {
            state = "Recortado · pendiente de guardar";
            detail.dataset.state = "pending";
        } else if (savedRastersStale) {
            state = "Del polígono anterior · se descartará al guardar";
            detail.dataset.state = "pending";
        } else {
            state = "Guardado en el proyecto";
        }
        detail.textContent = formatBytes(raster.size_bytes) + " · " + state;
        text.append(title, detail);

        const button = document.createElement("button");
        button.type = "button";
        button.className = "button button-secondary";
        button.textContent = "Descargar";
        button.addEventListener("click", function () {
            if (clipped) {
                downloadBlob(base64ToBlob(clipped.data, "image/tiff"), clipped.filename);
            } else {
                window.location.href = "/api/projects/" + encodeURIComponent(activeProjectId) +
                    "/rasters/" + encodeURIComponent(product);
            }
        });

        item.append(text, button);
        rasterList.appendChild(item);
    });

    rasterResults.hidden = rasterList.children.length === 0;
    refreshModelLayers();
}

function activePreview(product) {
    const preview = clippedRasters[product]
        ? clippedRasters[product].preview
        : savedPreviews[product];
    return preview && preview.min !== null ? preview : null;
}

// Pinta en el mapa el modelo elegido con una única escala de cotas para los dos,
// de forma que el mismo color signifique la misma altura en el MDT y en el MDS.
function refreshModelLayers() {
    const previews = {};
    PRODUCT_CODES.forEach(function (product) {
        const preview = activePreview(product);
        if (preview) {
            previews[product] = preview;
        }
    });
    const loaded = Object.keys(previews);

    const modelsChanged = PRODUCT_CODES.some(function (product) {
        return shownPreviews[product] !== previews[product];
    });
    shownPreviews = previews;

    PRODUCT_CODES.forEach(function (product) {
        if (modelLayers[product] && modelLayers[product].preview !== previews[product]) {
            map.removeLayer(modelLayers[product]);
            delete modelLayers[product];
        }
    });
    if (visibleModel && !previews[visibleModel]) {
        visibleModel = loaded[0] || PRODUCT_CODES[0];
    }
    modelButtons.forEach(function (button) {
        const model = button.dataset.model;
        button.setAttribute("aria-checked", String((model || null) === (loaded.length ? visibleModel : null)));
        button.disabled = Boolean(model) && !previews[model];
    });
    modelPanel.hidden = !loaded.length;
    if (modelsChanged) {
        onModelsChanged();
    }
    if (!loaded.length) {
        return;
    }

    const min = Math.min.apply(null, loaded.map(function (product) {
        return previews[product].min;
    }));
    const max = Math.max.apply(null, loaded.map(function (product) {
        return previews[product].max;
    }));
    const scaleKey = min + "|" + max;

    loaded.forEach(function (product) {
        const preview = previews[product];
        let layer = modelLayers[product];
        if (!layer || layer.scaleKey !== scaleKey) {
            if (layer) {
                map.removeLayer(layer);
            }
            layer = L.imageOverlay(paintElevation(preview, min, max), preview.bounds, {
                pane: "modelos",
                opacity: 0.85,
                interactive: false
            });
            layer.preview = preview;
            layer.scaleKey = scaleKey;
            modelLayers[product] = layer;
        }
        if (product === visibleModel) {
            layer.addTo(map);
        } else {
            map.removeLayer(layer);
        }
    });

    elevationLegend.hidden = !visibleModel;
    legendMin.textContent = formatElevation(min);
    legendMid.textContent = formatElevation((min + max) / 2);
    legendMax.textContent = formatElevation(max);
}

function previewGrid(preview) {
    if (!preview.grid) {
        const bytes = base64ToBytes(preview.data);
        preview.grid = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    }
    return preview.grid;
}

function paintElevation(preview, min, max) {
    const grid = previewGrid(preview);
    const width = preview.width;
    const height = preview.height;
    const range = max - min || 1;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const image = context.createImageData(width, height);
    const pixels = image.data;

    function elevationAt(row, column, fallback) {
        if (row < 0 || row >= height || column < 0 || column >= width) {
            return fallback;
        }
        const value = grid[row * width + column];
        return Number.isFinite(value) ? value : fallback;
    }

    for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
            const index = row * width + column;
            const elevation = grid[index];
            if (!Number.isFinite(elevation)) {
                continue;
            }

            // Sombreado de relieve: normal de la superficie frente a la luz del noroeste.
            const slopeEast = (elevationAt(row, column + 1, elevation) -
                elevationAt(row, column - 1, elevation)) / (2 * preview.cell_size);
            const slopeNorth = (elevationAt(row - 1, column, elevation) -
                elevationAt(row + 1, column, elevation)) / (2 * preview.cell_size);
            const normalLength = Math.sqrt(slopeEast * slopeEast + slopeNorth * slopeNorth + 1);
            const lighting = Math.max(0,
                (-slopeEast * LIGHT[0] - slopeNorth * LIGHT[1] + LIGHT[2]) / normalLength);
            const shade = Math.min(1.15, 0.35 + 0.65 * lighting / LIGHT[2]);

            const color = rampColor((elevation - min) / range);
            const offset = index * 4;
            pixels[offset] = Math.min(255, color[0] * shade);
            pixels[offset + 1] = Math.min(255, color[1] * shade);
            pixels[offset + 2] = Math.min(255, color[2] * shade);
            pixels[offset + 3] = 255;
        }
    }

    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
}

function rampColor(position) {
    const t = Math.min(1, Math.max(0, position));
    for (let index = 1; index < ELEVATION_RAMP.length; index += 1) {
        const upper = ELEVATION_RAMP[index];
        if (t <= upper[0]) {
            const lower = ELEVATION_RAMP[index - 1];
            const local = (t - lower[0]) / (upper[0] - lower[0]);
            return lower[1].map(function (channel, channelIndex) {
                return channel + (upper[1][channelIndex] - channel) * local;
            });
        }
    }
    return ELEVATION_RAMP[ELEVATION_RAMP.length - 1][1];
}

function formatElevation(value) {
    return value.toLocaleString("es-ES", { maximumFractionDigits: 0 });
}

async function loadSavedPreviews(projectId, products) {
    const failed = [];
    await Promise.all(products.map(async function (product) {
        try {
            const response = await fetch("/api/projects/" + encodeURIComponent(projectId) +
                "/rasters/" + encodeURIComponent(product) + "/preview");
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error);
            }
            if (activeProjectId === projectId) {
                savedPreviews[product] = result.preview;
            }
        } catch (error) {
            failed.push(product);
        }
    }));
    if (activeProjectId === projectId) {
        renderRasters();
        if (failed.length) {
            setStatus("No se pudo mostrar en el mapa: " + failed.join(", ") + ".", "error");
        }
    }
}

// Los modelos cargados han cambiado: el análisis anterior deja de valer y la cota
// del despegue se vuelve a leer del MDT02 nuevo.
function onModelsChanged() {
    clearCollisions();
    const mdt = activePreview("MDT02");
    if (takeoff) {
        const elevation = mdt ? sampleGrid(mdt, takeoff.latlng) : null;
        if (elevation === null) {
            clearTakeoff();
            setFlightStatus("El punto de despegue ya no está dentro del MDT02 cargado. Márcalo de nuevo.", "error");
        } else {
            takeoff.elevation = elevation;
            showTakeoff();
        }
    } else {
        setFlightStatus(mdt
            ? "Marca el punto de despegue en el mapa."
            : "Recorta o abre un MDT02 para marcar el punto de despegue.");
    }
    updateFlightControls();
}

function setTakeoff(latlng) {
    const mdt = activePreview("MDT02");
    const elevation = mdt ? sampleGrid(mdt, latlng) : null;
    if (elevation === null) {
        setFlightStatus("El punto de despegue tiene que estar dentro de la zona recortada del MDT02.", "error");
        return;
    }
    takeoff = { latlng: latlng, elevation: elevation };
    clearCollisions();
    showTakeoff();
    setFlightStatus("Despegue marcado. Indica la altura de vuelo y pulsa «Comprobar colisiones».");
    updateFlightControls();
}

function showTakeoff() {
    const utm = utmCoordinates(takeoff.latlng);
    takeoffCoords.textContent = utm.x + ", " + utm.y + " (huso " + utm.zone + ")";
    takeoffElevationValue.textContent = formatMeters(takeoff.elevation);
    takeoffInfo.hidden = false;
    if (!takeoffMarker) {
        takeoffMarker = L.circleMarker(takeoff.latlng, {
            radius: 8,
            color: "#ffffff",
            weight: 3,
            fillColor: "#102a43",
            fillOpacity: 1
        }).addTo(map);
    }
    takeoffMarker.setLatLng(takeoff.latlng);
    takeoffMarker.bindTooltip("Despegue · cota MDT " + formatMeters(takeoff.elevation));
}

function clearTakeoff() {
    takeoff = null;
    pickingTakeoff = false;
    map.getContainer().classList.remove("map-picking");
    if (takeoffMarker) {
        map.removeLayer(takeoffMarker);
        takeoffMarker = null;
    }
    takeoffInfo.hidden = true;
    clearCollisions();
    updateFlightControls();
}

function updateFlightControls() {
    takeoffButton.disabled = !activePreview("MDT02");
    collisionButton.disabled = !takeoff;
}

function runCollisionCheck() {
    if (!takeoff) {
        return;
    }
    clearCollisions();

    const height = Number(flightHeightInput.value);
    const margin = Number(safetyMarginInput.value || 0);
    if (!Number.isFinite(height) || height <= 0) {
        setFlightStatus("Introduce una altura de vuelo mayor que 0 m.", "error");
        return;
    }
    if (!Number.isFinite(margin) || margin < 0) {
        setFlightStatus("El margen de seguridad no puede ser negativo.", "error");
        return;
    }

    const flightAltitude = takeoff.elevation + height;
    // Todo lo que quede por encima de este límite cuenta como colisión.
    const limit = flightAltitude - margin;
    const labels = { MDT02: "MDT02 · terreno", MDS02: "MDS02 · superficies" };

    PRODUCT_CODES.forEach(function (product) {
        const preview = activePreview(product);
        if (!preview) {
            addCollisionItem("info", labels[product], product + " no está cargado: no se ha comprobado.");
            return;
        }

        const result = analyseCollisions(preview, limit, COLLISION_COLORS[product]);
        const clearance = flightAltitude - result.maxElevation;
        const color = "rgb(" + COLLISION_COLORS[product].join(",") + ")";
        collisionLayers.push(
            L.circleMarker(result.highest, {
                pane: "colisiones",
                radius: 6,
                color: "#ffffff",
                weight: 2,
                fillColor: color,
                fillOpacity: 1
            }).bindTooltip(product + " · punto más alto " + formatMeters(result.maxElevation)).addTo(map)
        );

        if (!result.collisions) {
            addCollisionItem(
                "ok",
                labels[product],
                "Sin colisión. Holgura mínima " + formatMeters(clearance) +
                " sobre el punto más alto (" + formatMeters(result.maxElevation) + ").",
                color
            );
            return;
        }

        collisionLayers.push(
            L.imageOverlay(result.image, preview.bounds, {
                pane: "colisiones",
                interactive: false
            }).addTo(map)
        );
        const cellArea = preview.cell_size * preview.cell_size;
        const percent = result.collisions / result.cells * 100;
        addCollisionItem(
            "collision",
            labels[product],
            "Colisión en " + formatArea(result.collisions * cellArea) + " (" +
            percent.toLocaleString("es-ES", { maximumFractionDigits: 1 }) + " % de la zona). " +
            (clearance < 0
                ? "El punto más alto (" + formatMeters(result.maxElevation) + ") supera la altitud de vuelo en " +
                    formatMeters(-clearance) + "."
                : "El punto más alto (" + formatMeters(result.maxElevation) + ") queda " +
                    formatMeters(clearance) + " por debajo, dentro del margen de seguridad."),
            color
        );
    });

    collisionResults.hidden = false;
    collisionShown = true;
    const mdt = activePreview("MDT02");
    setFlightStatus(
        "Altitud de vuelo " + formatMeters(flightAltitude) + " = cota del despegue " +
        formatMeters(takeoff.elevation) + " + " + height + " m." +
        (margin ? " Cuenta como colisión todo lo que quede a menos de " + margin + " m de esa altitud." : "") +
        " Celdas de análisis de " + mdt.cell_size.toLocaleString("es-ES", { maximumFractionDigits: 1 }) + " m."
    );
}

// Recorre la malla de cotas: cuenta las celdas por encima del límite, las pinta
// y localiza el punto más alto de la zona.
function analyseCollisions(preview, limit, color) {
    const grid = previewGrid(preview);
    const width = preview.width;
    const height = preview.height;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const image = context.createImageData(width, height);
    const pixels = image.data;
    let cells = 0;
    let collisions = 0;
    let maxElevation = -Infinity;
    let maxIndex = 0;

    for (let index = 0; index < grid.length; index += 1) {
        const elevation = grid[index];
        if (!Number.isFinite(elevation)) {
            continue;
        }
        cells += 1;
        if (elevation > maxElevation) {
            maxElevation = elevation;
            maxIndex = index;
        }
        if (elevation >= limit) {
            collisions += 1;
            const offset = index * 4;
            pixels[offset] = color[0];
            pixels[offset + 1] = color[1];
            pixels[offset + 2] = color[2];
            pixels[offset + 3] = 215;
        }
    }

    let imageUrl = null;
    if (collisions) {
        context.putImageData(image, 0, 0);
        imageUrl = canvas.toDataURL("image/png");
    }
    return {
        cells: cells,
        collisions: collisions,
        maxElevation: maxElevation,
        highest: gridCellLatLng(preview, Math.floor(maxIndex / width), maxIndex % width),
        image: imageUrl
    };
}

function addCollisionItem(state, title, text, color) {
    const item = document.createElement("li");
    item.className = "collision-item";
    item.dataset.state = state;
    const heading = document.createElement("strong");
    if (color) {
        const swatch = document.createElement("span");
        swatch.className = "collision-swatch";
        swatch.style.background = color;
        heading.appendChild(swatch);
    }
    heading.appendChild(document.createTextNode(title));
    item.append(heading, document.createTextNode(text));
    collisionResults.appendChild(item);
}

function clearCollisions() {
    collisionLayers.forEach(function (layer) {
        map.removeLayer(layer);
    });
    collisionLayers = [];
    collisionResults.replaceChildren();
    collisionResults.hidden = true;
    collisionShown = false;
}

function setFlightStatus(message, state) {
    flightStatus.textContent = message;
    if (state) {
        flightStatus.dataset.state = state;
    } else {
        delete flightStatus.dataset.state;
    }
}

// La malla de la vista previa está en Web Mercator: se pasa el punto a esa
// proyección para saber en qué celda cae.
function toMercator(latlng) {
    return {
        x: EARTH_RADIUS_MERCATOR * latlng.lng * Math.PI / 180,
        y: EARTH_RADIUS_MERCATOR * Math.log(Math.tan(Math.PI / 4 + latlng.lat * Math.PI / 360))
    };
}

function previewExtent(preview) {
    return {
        sw: toMercator(L.latLng(preview.bounds[0])),
        ne: toMercator(L.latLng(preview.bounds[1]))
    };
}

function sampleGrid(preview, latlng) {
    const extent = previewExtent(preview);
    const point = toMercator(latlng);
    const column = Math.floor((point.x - extent.sw.x) / (extent.ne.x - extent.sw.x) * preview.width);
    const row = Math.floor((extent.ne.y - point.y) / (extent.ne.y - extent.sw.y) * preview.height);
    if (row < 0 || row >= preview.height || column < 0 || column >= preview.width) {
        return null;
    }
    const value = previewGrid(preview)[row * preview.width + column];
    return Number.isFinite(value) ? value : null;
}

function gridCellLatLng(preview, row, column) {
    const extent = previewExtent(preview);
    const x = extent.sw.x + (column + 0.5) / preview.width * (extent.ne.x - extent.sw.x);
    const y = extent.ne.y - (row + 0.5) / preview.height * (extent.ne.y - extent.sw.y);
    return L.latLng(
        (2 * Math.atan(Math.exp(y / EARTH_RADIUS_MERCATOR)) - Math.PI / 2) * 180 / Math.PI,
        x / EARTH_RADIUS_MERCATOR * 180 / Math.PI
    );
}

function utmCoordinates(latlng) {
    const zone = Math.min(60, Math.max(1, Math.floor((latlng.lng + 180) / 6) + 1));
    const epsg = "EPSG:" + (25800 + zone);
    proj4.defs(epsg, "+proj=utm +zone=" + zone + " +ellps=GRS80 +units=m +no_defs +type=crs");
    const projected = proj4("EPSG:4326", epsg, [latlng.lng, latlng.lat]);
    return { x: projected[0].toFixed(2), y: projected[1].toFixed(2), zone: zone };
}

function formatMeters(value) {
    return value.toLocaleString("es-ES", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
    }) + " m";
}

function etrs89UtmCentroid(latLngs) {
    const longitude = latLngs.reduce(function (sum, point) {
        return sum + point.lng;
    }, 0) / latLngs.length;
    const zone = Math.min(60, Math.max(1, Math.floor((longitude + 180) / 6) + 1));
    const epsg = "EPSG:" + (25800 + zone);

    proj4.defs(
        epsg,
        "+proj=utm +zone=" + zone + " +ellps=GRS80 +units=m +no_defs +type=crs"
    );

    const projectedRing = latLngs.map(function (point) {
        return proj4("EPSG:4326", epsg, [point.lng, point.lat]);
    });
    const originX = projectedRing[0][0];
    const originY = projectedRing[0][1];
    const localRing = projectedRing.map(function (point) {
        return [point[0] - originX, point[1] - originY];
    });
    let crossSum = 0;
    let xSum = 0;
    let ySum = 0;

    for (let index = 0; index < localRing.length; index += 1) {
        const current = localRing[index];
        const next = localRing[(index + 1) % localRing.length];
        const cross = current[0] * next[1] - next[0] * current[1];
        crossSum += cross;
        xSum += (current[0] + next[0]) * cross;
        ySum += (current[1] + next[1]) * cross;
    }

    if (Math.abs(crossSum) < 1e-8) {
        throw new Error("No se pudo calcular el centroide del polígono.");
    }

    return {
        x: (originX + xSum / (3 * crossSum)).toFixed(2),
        y: (originY + ySum / (3 * crossSum)).toFixed(2),
        crs: "Huso " + zone + "N · " + epsg
    };
}

function geodesicArea(latLngs) {
    const earthRadius = 6371008.8;
    let area = 0;

    for (let index = 0; index < latLngs.length; index += 1) {
        const current = latLngs[index];
        const next = latLngs[(index + 1) % latLngs.length];
        const longitudeDelta = (next.lng - current.lng) * Math.PI / 180;
        const currentLatitude = current.lat * Math.PI / 180;
        const nextLatitude = next.lat * Math.PI / 180;
        area += longitudeDelta * (2 + Math.sin(currentLatitude) + Math.sin(nextLatitude));
    }

    return Math.abs(area * earthRadius * earthRadius / 2);
}

function formatArea(areaSquareMeters) {
    if (areaSquareMeters >= 1000000) {
        return (areaSquareMeters / 1000000).toLocaleString("es-ES", {
            maximumFractionDigits: 2
        }) + " km²";
    }
    return Math.round(areaSquareMeters).toLocaleString("es-ES") + " m²";
}

function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) {
        return (bytes / (1024 * 1024)).toLocaleString("es-ES", {
            maximumFractionDigits: 1
        }) + " MB";
    }
    return Math.max(1, Math.round(bytes / 1024)).toLocaleString("es-ES") + " KB";
}

function setStatus(message, state) {
    statusMessage.textContent = message;
    if (state) {
        statusMessage.dataset.state = state;
    } else {
        delete statusMessage.dataset.state;
    }
}

function downloadBlob(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
}

function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function base64ToBlob(base64, type) {
    return new Blob([base64ToBytes(base64)], { type: type });
}

function clipSelectedRasters() {
    const products = productsWithFiles();
    if (!selectedPolygon || !products.length || isClipping) {
        return;
    }

    const productLabel = products.join(" y ");
    const formData = new FormData();
    formData.append("geometry", JSON.stringify(selectedPolygon.toGeoJSON().geometry));
    products.forEach(function (product) {
        selectedFiles(product).forEach(function (file) {
            formData.append("rasters_" + product, file, file.name);
        });
    });

    isClipping = true;
    progressWrap.hidden = false;
    progressBar.style.width = "0%";
    progressLabel.textContent = "Subiendo GeoTIFF…";
    setStatus("Subiendo archivos y recortando " + productLabel + ".");
    updateSelection();

    const request = new XMLHttpRequest();
    request.open("POST", "/api/clip");
    request.responseType = "json";
    request.upload.addEventListener("progress", function (event) {
        if (event.lengthComputable) {
            const percent = Math.min(99, Math.round(event.loaded / event.total * 100));
            progressBar.style.width = percent + "%";
            progressLabel.textContent = percent < 99 ? "Subida: " + percent + "%" : "Recortando…";
        }
    });
    request.addEventListener("load", function () {
        const result = request.response;
        if (request.status >= 200 && request.status < 300 && result && Array.isArray(result.rasters)) {
            result.rasters.forEach(function (raster) {
                clippedRasters[raster.product] = raster;
            });
            renderRasters();
            progressBar.style.width = "100%";
            progressLabel.textContent = "Recorte terminado";
            setStatus(
                productLabel + (products.length === 1 ? " recortado." : " recortados.") +
                " Guarda el proyecto para conservarlos o descárgalos abajo.",
                "success"
            );
            finishClipping();
            return;
        }

        const message = result && result.error
            ? result.error
            : "El servidor devolvió una respuesta inesperada. Comprueba que siga ejecutándose.";
        setStatus(message, "error");
        finishClipping();
    });
    request.addEventListener("error", function () {
        setStatus("No se pudo conectar con el servidor del visor. Comprueba que siga activo.", "error");
        finishClipping();
    });
    request.addEventListener("abort", function () {
        setStatus("Se canceló la carga de archivos.", "error");
        finishClipping();
    });
    request.send(formData);
}

async function loadProjects() {
    try {
        const response = await fetch("/api/projects");
        let result;
        try {
            result = await response.json();
        } catch (error) {
            throw new Error(
                "El servidor del visor no ha respondido correctamente. Si lo usas en local, " +
                "arráncalo con iniciar.ps1 y entra en http://127.0.0.1:5000."
            );
        }
        if (!response.ok) {
            throw new Error(result.error || "No se pudieron cargar los proyectos.");
        }
        savedProjects = result.projects;
        projectList.replaceChildren();
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = savedProjects.length
            ? "Selecciona un proyecto guardado"
            : "Todavía no hay proyectos";
        projectList.appendChild(placeholder);
        savedProjects.forEach(function (project) {
            const option = document.createElement("option");
            option.value = String(project.id);
            option.textContent = project.name + " · " +
                (project.products.length ? project.products.join(" + ") : "sin recortes");
            projectList.appendChild(option);
        });
        openProjectButton.disabled = true;
        setProjectsStatus(savedProjects.length + (savedProjects.length === 1
            ? " proyecto guardado en DRONES."
            : " proyectos guardados en DRONES."));
    } catch (error) {
        projectList.replaceChildren();
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "Base de datos no disponible";
        projectList.appendChild(option);
        openProjectButton.disabled = true;
        setProjectsStatus(error.message, "error");
    }
}

async function saveProject() {
    if (!selectedPolygon || !projectNameInput.value.trim()) {
        return;
    }

    saveProjectButton.disabled = true;
    setProjectsStatus("Guardando proyecto en DRONES…");

    const projectData = {
        name: projectNameInput.value.trim(),
        geometry: selectedPolygon.toGeoJSON().geometry,
        rasters: Object.values(clippedRasters).map(function (raster) {
            return {
                product: raster.product,
                metadata: raster.metadata,
                data: raster.data
            };
        })
    };

    try {
        const isUpdate = Boolean(activeProjectId);
        const response = await fetch(
            isUpdate ? "/api/projects/" + encodeURIComponent(activeProjectId) : "/api/projects",
            {
                method: isUpdate ? "PUT" : "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(projectData)
            }
        );
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "No se pudo guardar el proyecto.");
        }
        activeProjectId = result.project.id;
        const previews = {};
        result.project.rasters.forEach(function (raster) {
            previews[raster.product] = clippedRasters[raster.product]
                ? clippedRasters[raster.product].preview
                : savedPreviews[raster.product];
        });
        savedPreviews = previews;
        setSavedRasters(result.project.rasters);
        clippedRasters = {};
        renderRasters();
        const count = result.project.rasters.length;
        setProjectsStatus(
            "Proyecto guardado en DRONES" +
            (count ? " con " + count + " GeoTIFF." : " (sin GeoTIFF)."),
            "success"
        );
        await loadProjects();
        projectList.value = String(activeProjectId);
        openProjectButton.disabled = false;
        updateSelection();
    } catch (error) {
        setProjectsStatus(error.message, "error");
        updateSelection();
    }
}

function setSavedRasters(rasters) {
    savedRasters = {};
    (rasters || []).forEach(function (raster) {
        savedRasters[raster.product] = raster;
    });
    savedRastersStale = false;
}

async function openSelectedProject() {
    if (!projectList.value) {
        return;
    }

    try {
        const response = await fetch("/api/projects/" + encodeURIComponent(projectList.value));
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "No se pudo abrir el proyecto.");
        }
        const project = result.project;
        const layer = L.geoJSON(project.geometry, {
            style: {
                color: "#087e8b",
                weight: 3,
                fillColor: "#21a7a0",
                fillOpacity: 0.2
            }
        }).getLayers()[0];
        if (!layer) {
            throw new Error("El proyecto guardado no contiene un polígono válido.");
        }
        drawnItems.clearLayers();
        resetRasterInputs();
        selectedPolygon = layer;
        drawnItems.addLayer(layer);
        map.fitBounds(layer.getBounds(), { padding: [30, 30] });
        projectNameInput.value = project.name;
        activeProjectId = project.id;
        clippedRasters = {};
        savedPreviews = {};
        clearTakeoff();
        setSavedRasters(project.rasters);
        renderRasters();
        updateSelection();
        setProjectsStatus("Proyecto «" + project.name + "» abierto.", "success");
        loadSavedPreviews(project.id, project.rasters.map(function (raster) {
            return raster.product;
        }));
    } catch (error) {
        setProjectsStatus(error.message, "error");
    }
}

function startNewProject() {
    activeProjectId = null;
    selectedPolygon = null;
    clippedRasters = {};
    savedPreviews = {};
    clearTakeoff();
    setSavedRasters([]);
    drawnItems.clearLayers();
    projectNameInput.value = "";
    projectList.value = "";
    openProjectButton.disabled = true;
    resetRasterInputs();
    renderRasters();
    updateSelection();
    setProjectsStatus("Proyecto nuevo listo. Dibuja el área y asígnale un nombre.");
    setStatus("Dibuja el polígono y selecciona los GeoTIFF descargados.");
}

function setProjectsStatus(message, state) {
    projectsStatus.textContent = message;
    if (state) {
        projectsStatus.dataset.state = state;
    } else {
        delete projectsStatus.dataset.state;
    }
}

function finishClipping() {
    isClipping = false;
    updateSelection();
}

updateSelection();
