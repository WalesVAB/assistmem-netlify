-- Lançador de Tickets SAP — schema Supabase (Postgres).
-- Rode UMA vez em: Supabase > SQL Editor > New query > Run.

create table if not exists public.agencias (
  codigo text primary key, nome text not null, telefone text);
create table if not exists public.agentes (
  codigo text primary key, nome text not null);
create table if not exists public.ods (
  codigo text primary key, nome text not null);

create table if not exists public.tickets (
  id bigint generated always as identity primary key,
  tipo text, resumo text, texto text, agente text, data text, hora text,
  criado_em timestamptz default now());

create table if not exists public.textos_padrao (
  id bigint generated always as identity primary key,
  dados text, atualizado_por text, atualizado_em text,
  criado_em timestamptz default now());

-- Perfis: 1 linha por usuário do Supabase Auth. "num" é o id numérico que o app usa.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  num bigint generated always as identity unique,
  nome text not null,
  login text not null unique,
  cor text not null default '#0070f3',
  is_admin boolean not null default false,
  ativo boolean not null default true,
  criado_em timestamptz default now());

-- Funções auxiliares (security definer evita recursão de RLS)
create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and ativo);
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and ativo and is_admin);
$$;

alter table public.agencias enable row level security;
alter table public.agentes enable row level security;
alter table public.ods enable row level security;
alter table public.tickets enable row level security;
alter table public.textos_padrao enable row level security;
alter table public.profiles enable row level security;

-- Tabelas de cadastro: qualquer usuário ativo lê/cria/edita/apaga
do $$ declare t text; begin
  foreach t in array array['agencias','agentes','ods'] loop
    execute format('drop policy if exists "rw" on public.%I', t);
    execute format('create policy "rw" on public.%I for all to authenticated using (public.is_active()) with check (public.is_active())', t);
  end loop;
end $$;

-- Tickets e textos padrão: ler e inserir (sem update/delete)
drop policy if exists "r" on public.tickets;
drop policy if exists "i" on public.tickets;
create policy "r" on public.tickets for select to authenticated using (public.is_active());
create policy "i" on public.tickets for insert to authenticated with check (public.is_active());
drop policy if exists "r" on public.textos_padrao;
drop policy if exists "i" on public.textos_padrao;
create policy "r" on public.textos_padrao for select to authenticated using (public.is_active());
create policy "i" on public.textos_padrao for insert to authenticated with check (public.is_active());

-- Perfis: usuários ativos leem; escrita só pela função Netlify (service role ignora RLS)
drop policy if exists "r" on public.profiles;
create policy "r" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_active());

create index if not exists tickets_criado_idx on public.tickets (id);

-- ---------------------------------------------------------------
-- DEPOIS: Authentication > Providers > Email: DESLIGUE "Allow new users to sign up"
-- (e, se quiser, "Confirm email"). Crie o 1º admin conforme o LEIA-ME.md.
--
-- Importar dados antigos (exporte do phpMyAdmin antigo como CSV e use
-- Table Editor > Import data): agencias, agentes, ods, tickets
-- (tickets: remova a coluna id para gerar novos), textos_padrao.
-- ---------------------------------------------------------------
