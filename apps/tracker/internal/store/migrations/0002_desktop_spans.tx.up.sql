alter table activity_spans alter column page_view_id drop not null;
alter table activity_spans add column app_name text;
alter table activity_spans add column bundle_id text;
alter table activity_spans add column window_title text;
alter table activity_spans add constraint activity_spans_identity_ck
    check ((page_view_id is null) <> (app_name is null));
create index activity_spans_started_idx on activity_spans (started_at desc);

create table categories (
    id   smallint generated always as identity primary key,
    name text not null unique
);
insert into categories (name) values ('Focus/Code'), ('Communication'), ('Distraction'), ('Learning');

create table category_rules (
    id           bigint generated always as identity primary key,
    category_id  smallint not null references categories,
    app_pattern  text,
    host_pattern text,
    priority     integer not null default 0,
    check (app_pattern is not null or host_pattern is not null)
);
create index category_rules_priority_idx on category_rules (priority desc, id);

insert into category_rules (category_id, app_pattern, host_pattern, priority)
select c.id, r.app_pattern, r.host_pattern, r.priority
from (values
    ('Focus/Code', '^(Code|Cursor|Xcode|Terminal|iTerm2|Ghostty|Warp|Zed|Instruments|Simulator)$'::text, null::text, 100),
    ('Focus/Code', null, '^(github\.com|localhost)$', 100),
    ('Communication', '^(Slack|Discord|Mail|Messages|zoom\.us|Microsoft Teams|FaceTime|WhatsApp|Telegram|Signal)$', null, 90),
    ('Communication', null, '^(app\.slack\.com|discord\.com|mail\.google\.com|web\.whatsapp\.com|teams\.microsoft\.com)$', 90),
    ('Learning', null, '(^|\.)(developer\.apple\.com|developer\.mozilla\.org|stackoverflow\.com|wikipedia\.org|arxiv\.org|substack\.com|medium\.com)$|^docs\.', 80),
    ('Distraction', null, '(^|\.)(youtube\.com|x\.com|twitter\.com|reddit\.com|instagram\.com|tiktok\.com|facebook\.com|news\.ycombinator\.com)$', 70)
) as r(category, app_pattern, host_pattern, priority)
join categories c on c.name = r.category;

create view categorized_spans as
select
    s.id,
    s.device_id,
    case when s.page_view_id is null then 'desktop' else 'page' end as source,
    u.host,
    s.app_name,
    s.bundle_id,
    s.window_title,
    s.started_at,
    s.ended_at,
    s.end_reason,
    extract(epoch from s.ended_at - s.started_at) as seconds,
    m.category
from activity_spans s
left join page_views p on p.id = s.page_view_id
left join urls u on u.id = p.url_id
left join lateral (
    select c.name as category
    from category_rules r
    join categories c on c.id = r.category_id
    where (r.app_pattern is not null and s.app_name ~* r.app_pattern)
       or (r.host_pattern is not null and u.host ~* r.host_pattern)
    order by r.priority desc, r.id
    limit 1
) m on true;

create view context_switches_hourly as
select
    date_trunc('hour', ended_at) as hour,
    count(*) filter (where end_reason in ('tab_switch', 'window_blur', 'app_switch')) as switches,
    count(*) as spans_ended
from activity_spans
where end_reason is not null
group by 1;

-- Blocks are global across devices on purpose: the extension and the desktop
-- agent run on the same machine under different device ids, and one person has
-- one attention stream.
create function work_blocks(from_ts timestamptz, to_ts timestamptz, max_gap interval default '60 seconds')
returns table (
    started_at timestamptz,
    ended_at timestamptz,
    active_seconds numeric,
    span_count bigint,
    switches bigint,
    dominant_category text
)
language sql
stable
as $$
    with overlapping as (
        select cs.started_at, cs.ended_at, cs.end_reason, cs.seconds, cs.category
        from categorized_spans cs
        where cs.started_at < to_ts and cs.ended_at > from_ts
    ),
    marked as (
        select o.*, case
            when o.started_at - max(o.ended_at) over (
                order by o.started_at rows between unbounded preceding and 1 preceding
            ) > max_gap then 1 else 0
        end as boundary
        from overlapping o
    ),
    blocked as (
        select m.*, sum(m.boundary) over (order by m.started_at rows unbounded preceding) as block
        from marked m
    )
    select
        min(b.started_at),
        max(b.ended_at),
        sum(b.seconds),
        count(*),
        count(*) filter (where b.end_reason in ('tab_switch', 'window_blur', 'app_switch')),
        (select d.category from blocked d
         where d.block = b.block and d.category is not null
         group by d.category order by sum(d.seconds) desc, d.category limit 1)
    from blocked b
    group by b.block
    order by 1;
$$;
