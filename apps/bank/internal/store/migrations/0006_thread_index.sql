-- `bank thread <id>` reads one conversation in chronological order.
create index messages_thread_idx on messages (thread_id, sent_at, id);
