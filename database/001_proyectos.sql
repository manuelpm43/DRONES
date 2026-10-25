CREATE TABLE IF NOT EXISTS public.proyectos (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name             varchar(120) NOT NULL,
    product          varchar(5) NOT NULL CHECK (product IN ('MDT02', 'MDS02')),
    geometry         jsonb NOT NULL,
    area_m2          double precision NOT NULL CHECK (area_m2 > 0),
    centroid_x       double precision NOT NULL,
    centroid_y       double precision NOT NULL,
    utm_zone         smallint NOT NULL CHECK (utm_zone BETWEEN 1 AND 60),
    utm_epsg         integer NOT NULL,
    source_files     jsonb NOT NULL DEFAULT '[]'::jsonb,
    output_filename  varchar(255),
    output_metadata  jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proyectos_updated_at_idx
    ON public.proyectos (updated_at DESC, id DESC);

-- Ejecutar con el usuario propietario de la base DRONES o un administrador.
-- Sustituir drones_app por el usuario de servicio elegido:
-- GRANT SELECT, INSERT, UPDATE ON public.proyectos TO drones_app;
-- GRANT USAGE, SELECT ON SEQUENCE public.proyectos_id_seq TO drones_app;
