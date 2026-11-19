-- Fechamento de pacientes · Clínica TM
-- Tabelas acessadas só pela Edge Function (service_role). RLS ligado sem políticas = nada público.

create extension if not exists pgcrypto;

-- Procedimentos que aparecem no app (a secretária pode adicionar novos)
create table if not exists public.procedimentos (
  id            serial primary key,
  nome          text not null unique,          -- como aparece no app
  rotulo_planilha text not null,               -- como vai para a planilha
  ordem         int  not null default 100,
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now()
);

insert into public.procedimentos (nome, rotulo_planilha, ordem) values
  ('Consulta',             'consulta particular', 1),
  ('Retorno',              'retorno',             2),
  ('Botox',                'botox',               3),
  ('Preenchimento',        'preenchedor',         4),
  ('Sculptra',             'sculptra',            5),
  ('Ultraformer',          'ultraformer',         6),
  ('Laser',                'laser',               7),
  ('NCTF',                 'NCTF',                8),
  ('Mesoterapia capilar',  'mesoterapia capilar', 9),
  ('Peeling',              'peeling',            10),
  ('Limpeza de pele',      'limpeza de pele',    11),
  ('Remoção de lesão',     'remoção de lesão',   12),
  ('Hialuronidase',        'hialuronidase',      13)
on conflict (nome) do nothing;

-- Um registro por paciente fechado na recepção
create table if not exists public.fechamentos (
  id                   uuid primary key,              -- gerado no celular (evita duplicar em toque duplo)
  criado_em            timestamptz not null default now(),
  data_atendimento     timestamptz not null,
  paciente_nome        text not null,
  amigo_patient_id     bigint,
  amigo_attendance_id  bigint,
  valor_pago           numeric(10,2) not null default 0,
  forma_pagamento      text not null,                  -- ja_pago | pix | debito | credito_vista | credito_parcelado | dois_cartoes | cartao_pix
  pagamentos           jsonb not null default '[]',    -- [{metodo, valor, parcelas}]
  parcelas             int,
  agendou_proxima      boolean not null default false,
  proxima_consulta     timestamptz,
  procedimentos        text[] not null default '{}',
  obs_procedimento     text,
  paciente_antiga      boolean not null,
  como_conheceu        text,
  recibo_path          text,
  recibo_token         uuid not null default gen_random_uuid(),
  resumo_prontuario    text,
  prontuario_status    text not null default 'pendente',  -- pendente | lancado
  prontuario_lancado_em timestamptz,
  planilha_status      text not null default 'pendente',  -- pendente | ok | erro | duplicado
  planilha_aba         text,
  planilha_linha       int,
  planilha_erro        text
);

create index if not exists fechamentos_data_idx on public.fechamentos (data_atendimento);
create index if not exists fechamentos_prontuario_idx on public.fechamentos (prontuario_status) where prontuario_status = 'pendente';

alter table public.procedimentos enable row level security;
alter table public.fechamentos   enable row level security;

-- Fila do prontuário (lida no "fechar o dia")
create or replace view public.fila_prontuario
with (security_invoker = true) as
select id, data_atendimento, paciente_nome, amigo_patient_id, resumo_prontuario
from public.fechamentos
where prontuario_status = 'pendente'
order by data_atendimento;

-- Bucket privado dos recibos
insert into storage.buckets (id, name, public)
values ('recibos', 'recibos', false)
on conflict (id) do nothing;

-- Segredos no Vault (APP_PIN, AMIGO_TOKEN, GOOGLE_SA_JSON), lidos só pelo service_role
create or replace function public.get_app_secret(p_name text)
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1;
$$;

revoke all on function public.get_app_secret(text) from public, anon, authenticated;
grant execute on function public.get_app_secret(text) to service_role;
