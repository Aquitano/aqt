package main

import (
	"context"
	"strings"
	"testing"
)

func TestServeRefusesANonLoopbackAddressWithoutAuth(t *testing.T) {
	t.Setenv("TRACKER_OIDC_ISSUER", "")
	for _, listen := range []string{"0.0.0.0:8490", ":8490", "100.64.0.1:8490"} {
		err := cmdServe(context.Background(), []string{"--listen", listen})
		if err == nil || !strings.Contains(err.Error(), "without authentication") {
			t.Errorf("listen %s: err = %v, want a refusal", listen, err)
		}
	}
}
