# Visor UAS MDT02 / MDS02

Visor web local para planificar zonas de vuelo con MDT02 (terreno) o MDS02
(superficies). Permite dibujar y guardar proyectos, descargar el polígono
GeoJSON, cargar hojas CNIG y obtener un GeoTIFF mosaico recortado por el área.
Los registros del proyecto se guardan en PostgreSQL, en una base independiente
llamada `DRONES`; los rásteres no se almacenan dentro de la base.

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

Conéctate a la base de datos `DRONES` y aplica [database/001_proyectos.sql](./database/001_proyectos.sql)
con `drones_app` o un administrador. Si se aplica con un administrador,
concede los permisos indicados al final del archivo de migración.

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
3. Elige **MDT02** o **MDS02**. El botón de CNIG abrirá el catálogo del producto
   elegido: [MDT02 - 2.ª cobertura](https://centrodedescargas.cnig.es/CentroDescargas/modelo-digital-terreno-mdt02-segunda-cobertura)
   o [MDS02 - 2.ª cobertura](https://centrodedescargas.cnig.es/CentroDescargas/modelo-digital-superficies-mds02-segunda-cobertura).
4. Descarga manualmente todas las hojas GeoTIFF que cubren el polígono y
   selecciónalas en el visor.
5. Pulsa **Recortar MDT02** o **Recortar MDS02** para crear el mosaico
   recortado.
6. Asigna un nombre al proyecto y pulsa **Guardar proyecto**. Si abriste un
   proyecto existente, el botón actualizará ese registro. Usa **Nuevo** para
   empezar otro proyecto y el selector para volver a abrir los guardados.
7. El navegador descarga el GeoTIFF recortado (`MDT02_recortado.tif` o
   `MDS02_recortado.tif`), conservando el sistema de
   coordenadas y la resolución original del raster. El exterior del polígono se
   establece como NoData.

El recorte se procesa localmente; los archivos no se envían a un servicio
externo. En `DRONES` se guardan nombre, tipo de producto, polígono, área,
centroide ETRS89/UTM, nombres de hojas fuente y metadatos del GeoTIFF de
salida; el contenido ráster no se guarda en PostgreSQL. El visor admite
GeoTIFF proyectados en metros, con resolución cercana a 2 m, y hojas en el
mismo sistema de coordenadas. El área máxima por recorte es 50 km².

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
| `PORT` | 5000 | Puerto local del servidor |
| `DRONES_PGHOST` | — | Servidor PostgreSQL que aloja `DRONES` |
| `DRONES_PGPORT` | 5432 | Puerto PostgreSQL |
| `DRONES_PGDATABASE` | `DRONES` | Base PostgreSQL de proyectos |
| `DRONES_PGUSER` | — | Usuario PostgreSQL dedicado |
| `DRONES_PGPASSWORD` | — | Contraseña de ese usuario |
| `DRONES_PGSSLMODE` | — | Modo SSL opcional, por ejemplo `require` |

Los datos de MDT02/MDS02 se distribuyen bajo licencia CC-BY 4.0. Conserva la
atribución del CNIG/IGN cuando reutilices el producto recortado.
