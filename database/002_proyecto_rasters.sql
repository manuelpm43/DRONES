-- Cada proyecto guarda sus GeoTIFF recortados (un MDT02 y un MDS02 como máximo).
-- Ejecutar con el usuario propietario de la base DRONES o un administrador.

CREATE TABLE IF NOT EXISTS public.proyecto_rasters (
    proyecto_id  bigint NOT NULL REFERENCES public.proyectos (id) ON DELETE CASCADE,
    product      varchar(5) NOT NULL CHECK (product IN ('MDT02', 'MDS02')),
    filename     varchar(255) NOT NULL,
    size_bytes   integer NOT NULL CHECK (size_bytes > 0),
    metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
    data         bytea NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (proyecto_id, product)
);

-- Un proyecto ya no tiene un único producto: los recortes viven en proyecto_rasters.
-- Las columnas product, source_files, output_filename y output_metadata de
-- proyectos quedan sin uso y se conservan solo por los registros anteriores.
ALTER TABLE public.proyectos ALTER COLUMN product DROP NOT NULL;

-- Sustituir drones_app por el usuario de servicio elegido:
GRANT SELECT, INSERT, UPDATE, DELETE ON public.proyecto_rasters TO drones_app;
