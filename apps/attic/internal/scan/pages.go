package scan

import "context"

func eachPage[T any](ctx context.Context, next func(context.Context, T) ([]T, error), visit func(context.Context, T) error, afterItem func(context.Context) error) error {
	var after T
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		batch, err := next(ctx, after)
		if err != nil || len(batch) == 0 {
			return err
		}
		for _, p := range batch {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := visit(ctx, p); err != nil {
				return err
			}
			after = p
			if err := afterItem(ctx); err != nil {
				return err
			}
		}
	}
}

func (r *run) afterItem(ctx context.Context) error {
	if err := r.sc.MaybeCommit(ctx); err != nil {
		return err
	}
	r.progress(false)
	return nil
}
