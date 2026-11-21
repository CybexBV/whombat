package itest

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
)

// DropSetAside drops, at cleanup, the databases a restore set aside from db (<db>_set_aside_<time>).
func DropSetAside(t testing.TB, tl Tools, db string) {
	t.Cleanup(func() {
		ctx := context.Background()
		c, err := pgx.Connect(ctx, tl.AdminDSN)
		if err != nil {
			return
		}
		defer c.Close(ctx)
		rows, err := c.Query(ctx, "select datname from pg_database where datname like $1", db+"_set_aside_%")
		if err != nil {
			return
		}
		var names []string
		for rows.Next() {
			var n string
			if rows.Scan(&n) == nil {
				names = append(names, n)
			}
		}
		rows.Close()
		for _, n := range names {
			_, _ = c.Exec(ctx, "drop database if exists "+pgx.Identifier{n}.Sanitize()+" with (force)")
		}
	})
}

// DatabaseExists says whether a database exists.
func DatabaseExists(t testing.TB, tl Tools, db string) bool {
	t.Helper()
	ctx := context.Background()
	c, err := pgx.Connect(ctx, tl.AdminDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(ctx)
	var n int
	if err := c.QueryRow(ctx, "select count(*) from pg_database where datname = $1", db).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n > 0
}
