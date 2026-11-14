package httpapi

import (
	"context"

	"github.com/danielgtaylor/huma/v2"
)

// Op is an operation whose input is I and whose answer's body is O. The
// server registers a handler for it and a client calls it through the same
// value, so both read the method and path from one declaration, and the
// compiler holds the handler and every call to the same two types.
type Op[I, O any] struct{ Operation }

// StreamOp is an operation whose answer is bytes rather than JSON.
type StreamOp[I any] struct{ Operation }

// Register adds op to api. adjust changes Huma's operation before it is
// registered, such as its body limits. The result is the operation as
// registered, on which a streamed request body is documented.
func Register[I, O any](api huma.API, op Op[I, O], handler func(context.Context, *I) (*Body[O], error), adjust ...func(*huma.Operation)) *huma.Operation {
	return register(api, op.Operation, handler, adjust)
}

// RegisterEmpty adds an operation that answers with a status and no body.
func RegisterEmpty[I any](api huma.API, op Op[I, struct{}], handler func(context.Context, *I) error, adjust ...func(*huma.Operation)) *huma.Operation {
	return register(api, op.Operation, func(ctx context.Context, in *I) (*struct{}, error) {
		return nil, handler(ctx, in)
	}, adjust)
}

// RegisterStream adds an operation whose handler writes the answer itself.
func RegisterStream[I any](api huma.API, op StreamOp[I], handler func(context.Context, *I) (*huma.StreamResponse, error), adjust ...func(*huma.Operation)) *huma.Operation {
	return register(api, op.Operation, handler, adjust)
}

func register[I, O any](api huma.API, op Operation, handler func(context.Context, *I) (*O, error), adjust []func(*huma.Operation)) *huma.Operation {
	h := op.For(api)
	for _, f := range adjust {
		f(&h)
	}
	huma.Register(api, h, handler)
	return Registered(api, h.Method, h.Path)
}
