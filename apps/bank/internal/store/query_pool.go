package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ConfigureQuery must run before the store is shared. Ad-hoc SQL never uses the
// ingestion pool: SET ROLE cannot turn a superuser connection into a sandbox.
func (s *Store) ConfigureQuery(ctx context.Context, databaseURL string) error {
	if databaseURL == "" {
		return fmt.Errorf("BANK_QUERY_DATABASE_URL is required for ad-hoc queries")
	}
	if s.queryPool != nil {
		return fmt.Errorf("query connection already configured")
	}
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return fmt.Errorf("invalid BANK_QUERY_DATABASE_URL")
	}
	writeConfig := s.pool.Config().ConnConfig
	if config.ConnConfig.User == writeConfig.User || config.ConnConfig.Database != writeConfig.Database {
		return fmt.Errorf("query connection must use a different login on the archive database")
	}
	config.MaxConns = 4
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheStatement
	config.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	config.ConnConfig.RuntimeParams["statement_timeout"] = queryTimeout.String()
	config.ConnConfig.RuntimeParams["search_path"] = "pg_catalog, public"
	config.AfterConnect = validateQueryRole
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return fmt.Errorf("open query connection: %w", err)
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return fmt.Errorf("restricted query connection: %w", err)
	}
	s.queryPool = pool
	return nil
}

func validateQueryRole(ctx context.Context, conn *pgx.Conn) error {
	var safe bool
	err := conn.QueryRow(ctx, `select
 current_user = session_user and r.rolcanlogin
 and not (r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls)
 and not exists (select 1 from pg_auth_members where member = r.oid)
 and has_schema_privilege(current_user, 'public', 'USAGE')
 and has_table_privilege(current_user, 'public.messages', 'SELECT')
 and not has_table_privilege(current_user, 'pg_catalog.pg_authid', 'SELECT')
 and not has_database_privilege(current_user, current_database(), 'CREATE')
 and not exists (select 1 from pg_namespace n where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
                 and has_schema_privilege(current_user, n.oid, 'CREATE'))
 and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and c.relkind in ('r','p','v','m','f')
                 and (c.relowner = r.oid or has_table_privilege(current_user, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
                      or has_any_column_privilege(current_user, c.oid, 'INSERT,UPDATE,REFERENCES')))
 and not exists (select 1 from pg_class c where c.relkind = 'S'
                 and (c.relowner = r.oid or has_sequence_privilege(current_user, c.oid, 'USAGE,UPDATE')))
 and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where ((p.prosecdef and not exists (
                   select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
                   where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                     and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e'
                     and e.extname = 'pg_search')) or (n.nspname = 'pg_catalog' and p.proname in
                   ('pg_read_file','pg_read_binary_file','pg_stat_file','pg_ls_dir','lo_import','lo_export')))
                 and has_function_privilege(current_user, p.oid, 'EXECUTE'))
 from pg_roles r where r.rolname = session_user`).Scan(&safe)
	if err != nil {
		return err
	}
	if !safe {
		return fmt.Errorf("query login must have only archive SELECT privileges, no role memberships and no administrative, ownership or write privileges")
	}
	return nil
}
