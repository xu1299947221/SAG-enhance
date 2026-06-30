alter table knowledge_edges
  add column if not exists evidence_start integer,
  add column if not exists evidence_end integer,
  add column if not exists quality_score numeric(6,4) not null default 0,
  add column if not exists extraction_method text not null default 'domain_profile_relation',
  add column if not exists extraction_model text,
  add column if not exists prompt_version text,
  add column if not exists status text not null default 'AUTO';

update knowledge_edges
set quality_score = greatest(quality_score, confidence)
where quality_score = 0;

alter table knowledge_edges
  drop constraint if exists knowledge_edges_status_check;

alter table knowledge_edges
  add constraint knowledge_edges_status_check
  check (status in ('AUTO', 'CONFIRMED', 'REJECTED', 'DISABLED'));

create index if not exists knowledge_edges_status_idx
  on knowledge_edges (source_id, status, relation_type);
create index if not exists knowledge_edges_quality_idx
  on knowledge_edges (source_id, quality_score desc, confidence desc);

create table if not exists entity_aliases (
  id uuid primary key,
  source_id uuid not null references sources(id) on delete cascade,
  entity_id uuid references entities(id) on delete cascade,
  alias text not null,
  canonical_name text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists entity_aliases_source_alias_unique_idx
  on entity_aliases (source_id, lower(alias));
create index if not exists entity_aliases_entity_idx
  on entity_aliases (entity_id);

create table if not exists relation_configs (
  id uuid primary key,
  source_id uuid not null references sources(id) on delete cascade,
  disabled_relations text[] not null default '{}',
  relation_aliases jsonb not null default '{}',
  entity_aliases jsonb not null default '{}',
  min_confidence jsonb not null default '{}',
  custom_relations jsonb not null default '[]',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists relation_configs_source_unique_idx
  on relation_configs (source_id);

create table if not exists edge_feedback (
  id uuid primary key,
  edge_id uuid not null references knowledge_edges(id) on delete cascade,
  source_id uuid not null references sources(id) on delete cascade,
  action text not null check (action in ('CONFIRM', 'REJECT', 'DISABLE', 'UPDATE')),
  previous_status text,
  next_status text,
  previous_value jsonb,
  next_value jsonb,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists edge_feedback_edge_idx
  on edge_feedback (edge_id, created_at desc);
create index if not exists edge_feedback_source_idx
  on edge_feedback (source_id, created_at desc);
