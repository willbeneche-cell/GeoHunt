-- GEOHUNT — salons persistants
-- À exécuter une seule fois dans Supabase : SQL Editor > New query > Run.
-- Les salons et joueurs sont publics (jeu sans compte) : RLS est volontairement
-- désactivé et les rôles anon/authenticated ont les droits CRUD nécessaires.

create table if not exists public.rooms (
  code text primary key,
  host_id text not null,
  center_lng double precision,
  center_lat double precision,
  radius integer not null default 500,
  duration integer not null default 15,
  phase text not null default 'lobby',
  round_number integer not null default 0,
  starts_at timestamptz,
  hide_ends_at timestamptz,
  ends_at timestamptz,
  extraction jsonb not null default '[]'::jsonb,
  ended_reason text not null default '',
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.room_players (
  id text primary key,
  room_code text not null references public.rooms(code) on delete cascade,
  name text not null,
  role text not null default 'hunter',
  status text not null default 'active',
  token text not null default '',
  lat double precision,
  lng double precision,
  accuracy double precision,
  out_reason text not null default '',
  captured_by text not null default '',
  extracted_at timestamptz,
  extracted_point text not null default '',
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

create index if not exists room_players_room_code_idx
  on public.room_players (room_code);

-- Jeu public : les clients utilisent uniquement la clé publishable.
alter table public.rooms disable row level security;
alter table public.room_players disable row level security;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.rooms to anon, authenticated;
grant select, insert, update, delete on public.room_players to anon, authenticated;

-- Recharge immédiatement le cache de schéma de l'API REST.
notify pgrst, 'reload schema';
