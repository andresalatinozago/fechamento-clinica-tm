alter table public.fechamentos add column if not exists nf_tipo text;
create index if not exists fechamentos_nf_idx on public.fechamentos (nf_tipo) where nf_tipo is not null and nf_tipo <> 'nao';
