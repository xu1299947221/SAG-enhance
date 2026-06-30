create table if not exists knowledge_edges (
  id uuid primary key,
  source_id uuid not null references sources(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,
  chunk_id uuid references source_chunks(id) on delete set null,
  event_id uuid references events(id) on delete cascade,
  subject_entity_id uuid not null references entities(id) on delete cascade,
  object_entity_id uuid not null references entities(id) on delete cascade,
  subject_name text not null,
  object_name text not null,
  relation_type text not null,
  relation_label text not null,
  evidence text,
  confidence numeric(5,4) not null default 0.7,
  metadata jsonb not null default '{}',
  search_text tsvector generated always as (
    to_tsvector(
      'simple',
      coalesce(subject_name, '') || ' ' ||
      coalesce(relation_label, '') || ' ' ||
      coalesce(relation_type, '') || ' ' ||
      coalesce(object_name, '') || ' ' ||
      coalesce(evidence, '')
    )
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists knowledge_edges_event_relation_unique_idx
  on knowledge_edges (event_id, subject_entity_id, relation_type, object_entity_id);
create index if not exists knowledge_edges_source_subject_idx
  on knowledge_edges (source_id, subject_entity_id, relation_type);
create index if not exists knowledge_edges_source_object_idx
  on knowledge_edges (source_id, object_entity_id, relation_type);
create index if not exists knowledge_edges_source_document_idx
  on knowledge_edges (source_id, document_id);
create index if not exists knowledge_edges_search_text_idx
  on knowledge_edges using gin (search_text);
