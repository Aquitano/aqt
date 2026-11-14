package search

// Rank runs a query's ranked lists through run and fuses the page [offset,
// offset+limit). Best match first requires every word. Only when fewer
// records than offset+limit hold them all does it run the lists again,
// requiring any word, and append the records it had not found yet, marked
// Partial. Fusing each tier on its own keeps a record that holds one word,
// ranked first in a short list, from outranking one that holds them all.
// lists are those of the last tier run, whose counts cover every record
// returned.
func Rank(q Query, offset, limit int, run func(Query) ([]List, error)) (hits []SearchHit, lists []List, err error) {
	if q.Mode != Best || q.Wanted() < 2 {
		if lists, err = run(q); err != nil {
			return nil, nil, err
		}
		return Fuse(lists, offset, limit), lists, nil
	}
	n := offset + limit
	every := q
	every.Mode = All
	if lists, err = run(every); err != nil {
		return nil, nil, err
	}
	found := Fuse(lists, 0, n)
	if len(found) < n {
		some := q
		some.Mode = Any
		if lists, err = run(some); err != nil {
			return nil, nil, err
		}
		held := make(map[string]bool, len(found))
		for _, h := range found {
			held[h.Key] = true
		}
		for _, h := range Fuse(lists, 0, n) {
			if !held[h.Key] {
				h.Partial = true
				found = append(found, h)
			}
		}
	}
	if offset >= len(found) {
		return []SearchHit{}, lists, nil
	}
	return found[offset:min(n, len(found))], lists, nil
}
