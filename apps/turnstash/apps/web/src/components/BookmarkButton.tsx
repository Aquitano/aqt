import type { BookmarkTarget } from "@aqt/turnstash-api";
import { Button } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useState } from "react";

import { api } from "../api";
import { queryKeys } from "../queries";
import { RequestFailure } from "./Async";
import { BookmarkNoteForm } from "./BookmarkNoteForm";

export const BookmarkButton = ({
  conversationId,
  target,
}: {
  readonly conversationId: string;
  readonly target: BookmarkTarget;
}) => {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const save = useMutation({
    mutationFn: () =>
      Effect.runPromise(api.admin.createBookmark({ payload: { conversationId, target, note } })),
    onSuccess: () => {
      setEditing(false);
      setNote("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.bookmarks });
    },
  });
  return (
    <div className="bookmark-action">
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setEditing(!editing);
          save.reset();
        }}
      >
        {save.isSuccess ? "Bookmarked" : "Bookmark"}
      </Button>
      {editing && (
        <BookmarkNoteForm
          note={note}
          onNoteChange={setNote}
          onSubmit={() => save.mutate()}
          onCancel={() => setEditing(false)}
          pending={save.isPending}
          submitLabel="Save"
          placeholder="Optional note"
        />
      )}
      {save.isError && <RequestFailure error={save.error} />}
    </div>
  );
};
