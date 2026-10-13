-- Run as the archive owner with psql -v ON_ERROR_STOP=1 -d bank.
-- Set the password separately with psql's \password bank_query prompt.
BEGIN;
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bank_query') THEN
        CREATE ROLE bank_query LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOREPLICATION NOBYPASSRLS;
    END IF;
END $$;
GRANT USAGE ON SCHEMA public TO bank_query;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO bank_query;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO bank_query;
ALTER DEFAULT PRIVILEGES FOR ROLE bank IN SCHEMA public
    GRANT SELECT ON TABLES TO bank_query;
ALTER DEFAULT PRIVILEGES FOR ROLE bank IN SCHEMA public
    GRANT SELECT ON SEQUENCES TO bank_query;
ALTER ROLE bank_query SET default_transaction_read_only = on;
ALTER ROLE bank_query SET statement_timeout = '15s';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE, TEMPORARY ON DATABASE bank FROM PUBLIC;
GRANT CONNECT ON DATABASE bank TO bank_query;
COMMIT;
