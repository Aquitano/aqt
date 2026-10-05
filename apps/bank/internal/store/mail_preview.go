package store

import "context"

const (
	mailPreviewMaxEntries    = 100000
	mailPreviewMaxReferences = 1000000
)

type MailPreview struct {
	// Resets counts how often the workspace filled up and started over. Inputs
	// after a reset are previewed against the database rather than against
	// proposals made before it, which only differs where those proposals
	// changed a grouping that a later input touches.
	Resets        int
	references    int
	nodes         map[string]mailNode
	members       map[int64]mailMember
	headers       map[int64]mailHeaders
	edges         map[int64][]mailEdge
	history       map[string][]string
	adjacent      map[string]map[mailEdge]bool
	byNode        map[string]map[int64]mailMember
	historyByNode map[string]map[string]bool
}

func (s *Store) PreviewMail(ctx context.Context, id int64, projection MailProjection, preview *MailPreview) (MailProjectionResult, error) {
	if preview.nodes == nil || len(preview.nodes) > mailPreviewMaxEntries || len(preview.members) > mailPreviewMaxEntries || preview.references > mailPreviewMaxReferences {
		resets := preview.Resets
		if preview.nodes != nil {
			resets++
		}
		*preview = MailPreview{
			Resets:        resets,
			nodes:         make(map[string]mailNode),
			members:       make(map[int64]mailMember),
			headers:       make(map[int64]mailHeaders),
			edges:         make(map[int64][]mailEdge),
			history:       make(map[string][]string),
			adjacent:      make(map[string]map[mailEdge]bool),
			byNode:        make(map[string]map[int64]mailMember),
			historyByNode: make(map[string]map[string]bool),
		}
	}
	return s.projectMail(ctx, id, projection, false, "", preview)
}

func (preview *MailPreview) remember(id int64, edges []mailEdge, members []mailMember, components []mailComponent, history []mailHistory) {
	for _, edge := range preview.edges[id] {
		delete(preview.adjacent[edge.Left], edge)
		delete(preview.adjacent[edge.Right], edge)
	}
	preview.references += len(edges) - len(preview.edges[id])
	preview.edges[id] = edges
	for _, edge := range edges {
		for _, key := range []string{edge.Left, edge.Right} {
			if preview.adjacent[key] == nil {
				preview.adjacent[key] = make(map[mailEdge]bool)
			}
			preview.adjacent[key][edge] = true
		}
	}
	for _, member := range members {
		if previous, exists := preview.members[member.ID]; exists {
			delete(preview.byNode[previous.Key], member.ID)
		}
		preview.members[member.ID] = member
		if preview.byNode[member.Key] == nil {
			preview.byNode[member.Key] = make(map[int64]mailMember)
		}
		preview.byNode[member.Key][member.ID] = member
	}
	for _, component := range components {
		for _, key := range component.Keys {
			preview.nodes[key] = mailNode{Key: key, ThreadID: component.ThreadID, Conflict: component.Conflict}
		}
	}
	for _, record := range history {
		for _, key := range preview.history[record.Key] {
			delete(preview.historyByNode[key], record.Key)
		}
		preview.references += len(record.Nodes) - len(preview.history[record.Key])
		preview.history[record.Key] = record.Nodes
		for _, key := range record.Nodes {
			if preview.historyByNode[key] == nil {
				preview.historyByNode[key] = make(map[string]bool)
			}
			preview.historyByNode[key][record.Key] = true
		}
	}
}
