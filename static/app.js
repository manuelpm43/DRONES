"use strict";

const PRODUCTS = {
    MDT02: {
        name: "Modelo Digital del Terreno",
        catalog: "https://centrodedescargas.cnig.es/CentroDescargas/modelo-digital-terreno-mdt02-segunda-cobertura",
        description: "MDT del suelo, con resolución de 2 m.",
        filename: "MDT02_recortado.tif"
    },
    MDS02: {
        name: "Modelo Digital de Superficies",
        catalog: "https://centrodedescargas.cnig.es/CentroDescargas/modelo-digital-superficies-mds02-segunda-cobertura",
        description: "MDS de superficies y elementos sobre el terreno, con resolución de 2 m.",
        filename: "MDS02_recortado.tif"
    }
};

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
const rasterFilesInput = document.getElementById("raster-files");
const fileSummary = document.getElementById("file-summary");
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
const productSelect = document.getElementById("product-select");
const catalogLink = document.getElementById("catalog-link");
const productDescription = document.getElementById("product-description");
const selectionBadge = document.getElementById("selection-badge");
const statusMessage = document.getElementById("status-message");
const progressWrap = document.getElementById("progress-wrap");
const progressBar = document.getElementById("progress-bar");
const progressLabel = document.getElementById("progress-label");

let selectedPolygon = null;
let isClipping = false;
let centroidCoordinates = null;
let activeProjectId = null;
let lastRasterMetadata = null;
let savedProjects = [];

drawButton.addEventListener("click", function () {
    drawControl.enable();
    setStatus("Marca los vértices y vuelve a hacer clic en el primero para cerrar el polígono.");
});

map.on(L.Draw.Event.CREATED, function (event) {
    drawnItems.clearLayers();
    selectedPolygon = event.layer;
    lastRasterMetadata = null;
    rasterFilesInput.value = "";
    fileSummary.textContent = "Puedes seleccionar varias hojas (.tif, .tiff)";
    drawnItems.addLayer(selectedPolygon);
    map.fitBounds(selectedPolygon.getBounds(), { padding: [30, 30] });
    updateSelection();
    setStatus("Polígono guardado. Descarga todas las hojas " + productSelect.value + " que cubran esta zona.");
});

clearButton.addEventListener("click", function () {
    drawnItems.clearLayers();
    selectedPolygon = null;
    centroidCoordinates = null;
    lastRasterMetadata = null;
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
productSelect.addEventListener("change", function () {
    updateProduct();
    lastRasterMetadata = null;
    rasterFilesInput.value = "";
    fileSummary.textContent = "Puedes seleccionar varias hojas (.tif, .tiff)";
    updateSelection();
});

exportButton.addEventListener("click", function () {
    if (!selectedPolygon) {
        return;
    }

    const feature = selectedPolygon.toGeoJSON();
    const collection = {
        type: "FeatureCollection",
        name: "area_mdt02",
        features: [feature]
    };
    downloadBlob(
        new Blob([JSON.stringify(collection, null, 2)], {
            type: "application/geo+json;charset=utf-8"
        }),
        "area_mdt02.geojson"
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

rasterFilesInput.addEventListener("change", function () {
    const files = Array.from(rasterFilesInput.files || []);
    fileSummary.textContent = files.length
        ? files.length + (files.length === 1 ? " GeoTIFF seleccionado" : " GeoTIFF seleccionados")
        : "Puedes seleccionar varias hojas (.tif, .tiff)";
    updateSelection();
    if (files.length) {
        setStatus("Comprueba que has seleccionado todas las hojas " + productSelect.value + " que cubren el polígono.");
    }
});

clipButton.addEventListener("click", clipSelectedRasters);
updateProduct();
loadProjects();

function updateSelection() {
    const hasPolygon = Boolean(selectedPolygon);
    const files = Array.from(rasterFilesInput.files || []);

    exportButton.disabled = !hasPolygon || isClipping;
    clearButton.disabled = !hasPolygon || isClipping;
    drawButton.disabled = isClipping;
    clipButton.disabled = !hasPolygon || files.length === 0 || isClipping;
    rasterFilesInput.disabled = isClipping;
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

function clipSelectedRasters() {
    if (!selectedPolygon || !rasterFilesInput.files.length || isClipping) {
        return;
    }

    const formData = new FormData();
    formData.append("geometry", JSON.stringify(selectedPolygon.toGeoJSON().geometry));
    formData.append("product", productSelect.value);
    Array.from(rasterFilesInput.files).forEach(function (file) {
        formData.append("rasters", file, file.name);
    });

    isClipping = true;
    progressWrap.hidden = false;
    progressBar.style.width = "0%";
    progressLabel.textContent = "Subiendo GeoTIFF…";
    setStatus("Subiendo archivos y recortando el " + productSelect.value + " en este equipo.");
    updateSelection();

    const request = new XMLHttpRequest();
    request.open("POST", "/api/clip");
    request.responseType = "blob";
    request.upload.addEventListener("progress", function (event) {
        if (event.lengthComputable) {
            const percent = Math.min(99, Math.round(event.loaded / event.total * 100));
            progressBar.style.width = percent + "%";
            progressLabel.textContent = "Subida: " + percent + "%";
        }
    });
    request.addEventListener("load", function () {
        if (request.status >= 200 && request.status < 300) {
            const filename = getDownloadFilename(request.getResponseHeader("Content-Disposition"));
            try {
                lastRasterMetadata = JSON.parse(request.getResponseHeader("X-Raster-Metadata") || "{}");
            } catch (error) {
                lastRasterMetadata = {
                    filename: filename,
                    product: productSelect.value
                };
            }
            downloadBlob(request.response, filename);
            progressBar.style.width = "100%";
            progressLabel.textContent = "Descarga iniciada";
            setStatus(productSelect.value + " recortado y descargado como " + filename + ".", "success");
            finishClipping();
            return;
        }

        readBlobText(request.response).then(function (body) {
            let message = "No se pudo recortar el " + productSelect.value + ".";
            try {
                const error = JSON.parse(body);
                if (error.error) {
                    message = error.error;
                }
            } catch (parseError) {
                message = "El servidor devolvió una respuesta inesperada. Comprueba que siga ejecutándose.";
            }
            setStatus(message, "error");
            finishClipping();
        });
    });
    request.addEventListener("error", function () {
        setStatus("No se pudo conectar con el procesador local. Comprueba que server.py esté activo.", "error");
        finishClipping();
    });
    request.addEventListener("abort", function () {
        setStatus("Se canceló la carga de archivos.", "error");
        finishClipping();
    });
    request.send(formData);
}

function updateProduct() {
    const product = PRODUCTS[productSelect.value];
    catalogLink.href = product.catalog;
    document.getElementById("catalog-link-label").textContent =
        "Abrir " + productSelect.value + " en CNIG";
    productDescription.textContent = product.description;
    clipButton.textContent = "Recortar " + productSelect.value;
}

async function loadProjects() {
    try {
        const response = await fetch("/api/projects");
        const result = await response.json();
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
            option.textContent = project.name + " · " + project.product;
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

    const selectedFiles = Array.from(rasterFilesInput.files || []).map(function (file) {
        return file.name;
    });
    const projectData = {
        name: projectNameInput.value.trim(),
        product: productSelect.value,
        geometry: selectedPolygon.toGeoJSON().geometry,
        source_files: lastRasterMetadata && Array.isArray(lastRasterMetadata.source_files)
            ? lastRasterMetadata.source_files
            : selectedFiles,
        output_metadata: lastRasterMetadata && lastRasterMetadata.product === productSelect.value
            ? lastRasterMetadata
            : {}
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
        setProjectsStatus("Proyecto guardado en DRONES.", "success");
        await loadProjects();
        projectList.value = String(activeProjectId);
        openProjectButton.disabled = false;
        updateSelection();
    } catch (error) {
        setProjectsStatus(error.message, "error");
        updateSelection();
    }
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
        rasterFilesInput.value = "";
        fileSummary.textContent = "Puedes seleccionar varias hojas (.tif, .tiff)";
        selectedPolygon = layer;
        drawnItems.addLayer(layer);
        map.fitBounds(layer.getBounds(), { padding: [30, 30] });
        projectNameInput.value = project.name;
        productSelect.value = project.product;
        activeProjectId = project.id;
        lastRasterMetadata = project.output_metadata && project.output_metadata.filename
            ? project.output_metadata
            : null;
        updateProduct();
        updateSelection();
        setProjectsStatus("Proyecto «" + project.name + "» abierto.", "success");
    } catch (error) {
        setProjectsStatus(error.message, "error");
    }
}

function startNewProject() {
    activeProjectId = null;
    selectedPolygon = null;
    lastRasterMetadata = null;
    drawnItems.clearLayers();
    projectNameInput.value = "";
    projectList.value = "";
    openProjectButton.disabled = true;
    productSelect.value = "MDT02";
    rasterFilesInput.value = "";
    fileSummary.textContent = "Puedes seleccionar varias hojas (.tif, .tiff)";
    updateProduct();
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

function readBlobText(blob) {
    if (blob && typeof blob.text === "function") {
        return blob.text();
    }
    return new Promise(function (resolve) {
        const reader = new FileReader();
        reader.onload = function () {
            resolve(String(reader.result || ""));
        };
        reader.onerror = function () {
            resolve("");
        };
        reader.readAsText(blob);
    });
}

function getDownloadFilename(contentDisposition) {
    if (!contentDisposition) {
        return "MDT02_recortado.tif";
    }

    const encodedName = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (encodedName) {
        try {
            return decodeURIComponent(encodedName[1]);
        } catch (error) {
            return "MDT02_recortado.tif";
        }
    }

    const simpleName = contentDisposition.match(/filename="?([^";]+)"?/i);
    return simpleName ? simpleName[1] : "MDT02_recortado.tif";
}

updateSelection();
