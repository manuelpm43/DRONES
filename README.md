# Visor UAS MDT02 / MDS02

Visor web local para planificar zonas de vuelo con MDT02 (terreno) y MDS02
(superficies). Permite dibujar y guardar proyectos, descargar el polígono
GeoJSON, cargar hojas CNIG de los dos productos y obtener un GeoTIFF mosaico
recortado por el área para cada uno. Los proyectos, incluidos los dos GeoTIFF
recortados, se guardan en PostgreSQL, en una base independiente llamada `DRONES`.

## Requisitos

- Python 3.9 o posterior.
- Conexión a internet para mostrar la cartografía PNOA y abrir el catálogo del
  CNIG.

## Puesta en marcha en Windows

### Crear y preparar la base de datos

En el servidor PostgreSQL utilizado por BIDELAN, con un usuario administrador,
crea un usuario exclusivo y la base de datos:

```sql
CREATE ROLE drones_app LOGIN PASSWORD 'una-contraseña-segura';
CREATE DATABASE "DRONES" OWNER drones_app;
```

Conéctate a la base de datos `DRONES` y aplica, en orden,
[database/001_proyectos.sql](./database/001_proyectos.sql) y
[database/002_proyecto_rasters.sql](./database/002_proyecto_rasters.sql)
con `drones_app` o un administrador. Si se aplican con un administrador,
concede los permisos indicados al final de cada migración.

En el equipo que ejecutará el visor, copia `.env.example` a `.env` y configura
la conexión PostgreSQL con credenciales propias de `drones_app`. No reutilices
las credenciales de la aplicación BIDELAN ni guardes contraseñas en el código.

### Arrancar el visor

Desde PowerShell, en `C:\Proyectos\DRONES`:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
.\iniciar.ps1
```

Abre <http://127.0.0.1:5000> en el navegador. El servidor web escucha solo en
el equipo local.

El puerto 5432 del servidor PostgreSQL está cerrado a internet, así que
`iniciar.ps1` abre primero un túnel SSH (`DRONES_SSH_HOST`, `DRONES_SSH_USER`,
`DRONES_SSH_KEY` en `.env`) que expone la base en `127.0.0.1:5433` y después
arranca `server.py`. Al pulsar Ctrl+C se cierran el visor y el túnel. El
usuario SSH debe tener la clave pública autorizada en el servidor.

## Flujo de trabajo

1. Dibuja el perímetro de la zona de vuelo en el mapa PNOA.
2. Consulta el centroide que aparece como coordenadas **X (Este), Y (Norte)**
   en ETRS89 / UTM; se indica el huso y el código EPSG. Puedes copiar el par
   `X, Y` y pegarlo en el localizador por coordenadas del CNIG.
3. Abre los catálogos del CNIG con los botones del visor:
   [MDT02 - 2.ª cobertura](https://centrodedescargas.cnig.es/CentroDescargas/modelo-digital-terreno-mdt02-segunda-cobertura)
   y [MDS02 - 2.ª cobertura](https://centrodedescargas.cnig.es/CentroDescargas/modelo-digital-superficies-mds02-segunda-cobertura).
4. Descarga manualmente todas las hojas GeoTIFF de cada producto que cubren el
   polígono y selecciónalas en su casilla del visor (**Hojas MDT02** y
   **Hojas MDS02**).
5. Pulsa **Recortar MDT02 y MDS02**: los dos mosaicos se recortan con el mismo
   polígono. Si solo cargas uno de los productos, se recorta solo ese.
6. Los GeoTIFF recortados (`MDT02_recortado.tif` y `MDS02_recortado.tif`)
   aparecen en la lista del paso 03 y pueden descargarse desde ahí. Conservan
   el sistema de coordenadas y la resolución original; el exterior del polígono
   se establece como NoData.
7. Asigna un nombre al proyecto y pulsa **Guardar proyecto**: se guardan el
   polígono y los GeoTIFF recortados. Si abriste un proyecto existente, el
   botón actualizará ese registro. Usa **Nuevo** para empezar otro proyecto y
   el selector para volver a abrir los guardados y descargar sus GeoTIFF.

Los modelos recortados o guardados se pintan sobre la ortofoto con una rampa de
color por cota y sombreado de relieve. El selector **Modelo en el mapa** (abajo a
la izquierda) muestra el MDT02, el MDS02 o ninguno; los dos usan la misma escala
de cotas, indicada en la leyenda.

### Análisis de vuelo (paso 04)

1. Pulsa **Marcar punto de despegue** y haz clic en el mapa dentro de la zona
   recortada: el visor lee la cota del MDT02 en ese punto.
2. Indica la **altura de vuelo sobre el despegue** y, si quieres, un **margen de
   seguridad**.
3. Pulsa **Comprobar colisiones**. La altitud de vuelo es la cota del despegue
   más la altura indicada; cada celda de la zona cuya cota la alcance (menos el
   margen) se marca en rojo si es del MDT02 (terreno) o en naranja si es del
   MDS02 (edificios, vegetación). El panel indica el área en colisión y la
   holgura sobre el punto más alto de cada modelo.

El análisis usa la malla que se pinta en el mapa, de como máximo 1024 celdas
de lado; en recortes grandes cada celda agrupa varios píxeles de 2 m y toma la
cota máxima de ellos, para no perder obstáculos.

Si cambias el polígono de un proyecto guardado y no vuelves a recortar un
producto, al guardar se descarta su GeoTIFF anterior, porque ya no corresponde
a la nueva zona.

El recorte se procesa localmente; los archivos no se envían a un servicio
externo. En `DRONES` se guardan nombre, polígono, área, centroide ETRS89/UTM y,
en la tabla `proyecto_rasters`, cada GeoTIFF recortado con sus metadatos y los
nombres de las hojas fuente. Las hojas originales del CNIG no se guardan. El
visor admite GeoTIFF proyectados en metros, con resolución cercana a 2 m, y
hojas en el mismo sistema de coordenadas. El área máxima por recorte es 50 km²
y cada GeoTIFF guardado puede ocupar hasta 64 MB.

## Servidor: drones.geospatiallab.xyz

El visor está publicado en <https://drones.geospatiallab.xyz>, en el mismo
servidor que BIDELAN (217.71.202.62, Ubuntu). Pide usuario y contraseña.

- **Código**: `/opt/drones`, un `git clone` de este repositorio. Como es privado,
  el servidor lo descarga con una *deploy key* de solo lectura
  (`/root/.ssh/drones_github_deploy`, registrada en GitHub → Settings → Deploy
  keys); el clon ya la tiene configurada en `core.sshCommand`.
- **Configuración**: `/opt/drones/.env` (solo root y el usuario `drones`).
  Conecta a PostgreSQL en `127.0.0.1:5432` sin túnel y define
  `DRONES_ALLOWED_HOSTS=drones.geospatiallab.xyz`.
- **Proceso**: servicio systemd `drones` ([deploy/drones.service](./deploy/drones.service)),
  gunicorn como usuario de sistema `drones`, escuchando solo en `127.0.0.1:5001`.
- **nginx**: sitio `drones` ([deploy/nginx-drones.conf](./deploy/nginx-drones.conf)),
  con HTTPS de Let's Encrypt (Certbot, renovación automática) y autenticación
  básica con los usuarios de `/etc/nginx/drones.htpasswd`.
- **DNS**: registro `A` `drones` → `217.71.202.62` en Cloudflare, en gris
  ("DNS only"), igual que `visor`; con el proxy activado Certbot no puede
  renovar el certificado.

Actualizar el servidor con lo último de GitHub (como root):

```bash
cd /opt/drones && git pull
.venv/bin/pip install -q -r requirements.txt   # solo si cambió requirements.txt
systemctl restart drones
```

Las migraciones nuevas de `database/` se aplican a mano con
`sudo -u postgres psql -d DRONES -f database/<migración>.sql`.

Añadir o cambiar la contraseña de un usuario del visor (como root):

```bash
printf "USUARIO:%s\n" "$(openssl passwd -6 'CONTRASEÑA')" >> /etc/nginx/drones.htpasswd
```

Para cambiar la contraseña de un usuario existente, borra antes su línea del
archivo. No hace falta recargar nginx.

## Pruebas

```powershell
python -m unittest discover -s tests
```

## Límites configurables

Las variables de entorno opcionales permiten ajustar los límites del servidor:

| Variable | Valor predeterminado | Uso |
| --- | ---: | --- |
| `MDT02_MAX_UPLOAD_BYTES` | 1 GiB | Tamaño máximo total de la carga |
| `MDT02_MAX_AREA_KM2` | 50 | Área máxima del polígono |
| `MDT02_MAX_FILES` | 20 | Número máximo de GeoTIFF por mosaico |
| `DRONES_MAX_RASTER_BYTES` | 64 MiB | Tamaño máximo de cada GeoTIFF recortado guardado en el proyecto |
| `PORT` | 5000 | Puerto local del servidor |
| `DRONES_PGHOST` | — | Servidor PostgreSQL que aloja `DRONES` |
| `DRONES_PGPORT` | 5432 | Puerto PostgreSQL |
| `DRONES_PGDATABASE` | `DRONES` | Base PostgreSQL de proyectos |
| `DRONES_PGUSER` | — | Usuario PostgreSQL dedicado |
| `DRONES_PGPASSWORD` | — | Contraseña de ese usuario |
| `DRONES_PGSSLMODE` | — | Modo SSL opcional, por ejemplo `require` |

Los datos de MDT02/MDS02 se distribuyen bajo licencia CC-BY 4.0. Conserva la
atribución del CNIG/IGN cuando reutilices el producto recortado.
