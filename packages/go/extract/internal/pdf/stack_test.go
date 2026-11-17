package pdf

import "testing"

func TestPopArgsOrder(t *testing.T) {
	var stk Stack
	stk.Push(testValue(int64(1)))
	stk.Push(testValue(int64(2)))
	stk.Push(testValue(int64(3)))

	args := popArgs(&stk)
	if len(args) != 3 {
		t.Fatalf("len(args) = %d, want 3", len(args))
	}
	for i, want := range []int64{1, 2, 3} {
		if args[i].Int64() != want {
			t.Fatalf("args[%d] = %d, want %d (bottom of stack first)", i, args[i].Int64(), want)
		}
	}
	if stk.Len() != 0 || !stk.Pop().IsNull() {
		t.Fatalf("stack not emptied by popArgs: Len() = %d", stk.Len())
	}
}
