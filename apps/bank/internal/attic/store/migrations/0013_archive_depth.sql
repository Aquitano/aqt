-- Unknown legacy depths preserve their listings until an explicit rebuild.
alter table archives
    add column depth integer check (depth >= 0);
