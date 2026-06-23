-- Esquema de LecturaCVs (espacio de equipo compartido, multiusuario en tiempo real).
-- Cada candidato y cada búsqueda es una fila => las ediciones de distintos usuarios
-- se combinan sin pisarse. Lectura/escritura de datos va SIEMPRE por el servidor
-- (service_role, que saltea RLS); el navegador solo puede leer la "señal" de cambios,
-- que no contiene datos personales.

-- Búsquedas (avisos)
create table if not exists public.searches (
  id text primary key,
  title text not null default '',
  first_date text,
  offered_salary text default '',
  offered_salary_max text,
  salary_range boolean default false,
  job_context text default '',
  criteria jsonb,
  posting text,
  plant_address text,
  sede_id text,
  filters jsonb,
  stages jsonb,
  sort_index int default 0,
  updated_at timestamptz not null default now()
);

-- Candidatos (una fila por candidato => actualizaciones granulares)
create table if not exists public.candidates (
  id text primary key,
  search_id text not null references public.searches(id) on delete cascade,
  source text,
  name text default '',
  cv_text text,
  expected_salary text default '',
  date text,
  email_uid bigint,
  status text default 'nuevo',
  calificacion text,
  stage_id text,
  notes text,
  score_status text default 'pending',
  error text,
  evaluation jsonb,
  evaluated_at text,
  updated_at timestamptz not null default now()
);
create index if not exists candidates_search_id_idx on public.candidates(search_id);

-- Ajustes compartidos (sedes + valores de empresa): una sola fila
create table if not exists public.app_settings (
  id text primary key default 'default',
  sedes jsonb,
  company_values text default '',
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id) values ('default') on conflict (id) do nothing;

-- Señal de cambios para tiempo real (NO contiene datos personales)
create table if not exists public.realtime_signal (
  id text primary key default 'default',
  scope text,
  search_id text,
  client_id text,
  updated_at timestamptz not null default now()
);
insert into public.realtime_signal (id) values ('default') on conflict (id) do nothing;

-- Seguridad: RLS activado en todo.
alter table public.searches enable row level security;
alter table public.candidates enable row level security;
alter table public.app_settings enable row level security;
alter table public.realtime_signal enable row level security;

-- El cliente solo puede leer la señal (sin datos personales).
drop policy if exists "signal_read" on public.realtime_signal;
create policy "signal_read" on public.realtime_signal for select using (true);

-- Publicar la señal en realtime (ignorar si ya estaba).
do $$ begin
  alter publication supabase_realtime add table public.realtime_signal;
exception when duplicate_object then null;
end $$;
