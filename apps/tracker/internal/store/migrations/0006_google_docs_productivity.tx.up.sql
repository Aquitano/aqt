-- The Learning seed's ^docs\. also takes docs.google.com: Docs, Sheets, Slides
-- and Forms. Seeded only while Learning still decides that host, so a rule
-- edited or added for it keeps its effect.
insert into category_rules (category_id, host_pattern, priority)
select c.id, '^docs\.google\.com$', 85
from categories c
where c.name = 'Productivity'
  and (
    select rc.name
    from category_rules r
    join categories rc on rc.id = r.category_id
    where 'docs.google.com' ~* r.host_pattern
    order by r.priority desc, r.id
    limit 1
  ) = 'Learning';
