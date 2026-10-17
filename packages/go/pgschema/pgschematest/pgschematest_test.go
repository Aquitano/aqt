package pgschematest

import (
	"net"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestOnlyAnAbsentServerIsSkipped(t *testing.T) {
	closed, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed.Close()
	hangUp, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer hangUp.Close()
	go func() {
		for {
			conn, err := hangUp.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()
	listens := func(hosts string) bool {
		conf, err := pgx.ParseConfig("postgres://u:p@" + hosts + "/db")
		if err != nil {
			t.Fatal(err)
		}
		return listening(t.Context(), conf)
	}
	if listens(closed.Addr().String()) {
		t.Error("a closed port counts as listening, so local runs without a server would fail")
	}
	// As when localhost resolves to ::1 with nothing listening and to
	// 127.0.0.1 with a server that refuses the login or hangs up.
	if !listens(closed.Addr().String() + "," + hangUp.Addr().String()) {
		t.Error("a server on the second address does not count as listening, so its failures would skip")
	}
}
