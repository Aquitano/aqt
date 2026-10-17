package pgschematest

import (
	"net"
	"net/url"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/peterldowns/pgtestdb"
)

func TestRefusedLoginIsNotUnreachable(t *testing.T) {
	u, err := url.Parse(Database(t, Env{URL: "PGSCHEMA_TEST_DATABASE_URL", Require: "PGSCHEMA_REQUIRE_DB"}, pgtestdb.NoopMigrator{}))
	if err != nil {
		t.Fatal(err)
	}
	closed, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed.Close()
	// As when localhost resolves to ::1 with nothing listening and to
	// 127.0.0.1 with a server.
	u.Host = closed.Addr().String() + "," + u.Host
	u.User = url.UserPassword(u.User.Username(), "wrong")
	_, err = pgx.Connect(t.Context(), u.String())
	if err == nil || unreachable(err) {
		t.Fatalf("err = %v, want a refused login, which fails instead of skipping", err)
	}
}
