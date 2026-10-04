import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

export interface Draft<T> {
  revision: number;
  baseline: T;
  value: T;
}

export function createDraft<T>(value: T, revision: number): Draft<T> {
  return { revision, baseline: value, value };
}

export function isDirty<T>(draft: Draft<T>) {
  return JSON.stringify(draft.value) !== JSON.stringify(draft.baseline);
}

export function refreshDraft<T>(draft: Draft<T>, value: T, revision: number): Draft<T> {
  return revision > draft.revision && !isDirty(draft) ? createDraft(value, revision) : draft;
}

export function saveDraft<T>(draft: Draft<T>, value: T, revision: number, submitted: T): Draft<T> {
  if (revision < draft.revision) return draft;
  return {
    revision,
    baseline: value,
    value: JSON.stringify(draft.value) === JSON.stringify(submitted) ? value : draft.value,
  };
}

export function keepLatest<T extends { revision: number }>(current: T | undefined, received: T): T {
  return current && current.revision > received.revision ? current : received;
}

export function useDraft<T>(kind: string, id: string, initial: T, revision: number) {
  const client = useQueryClient();
  const key = useMemo(() => ["draft", kind, id], [kind, id]);
  const { data: draft } = useQuery({
    queryKey: key,
    queryFn: () => createDraft(initial, revision),
    initialData: () => createDraft(initial, revision),
    enabled: false,
    gcTime: Infinity,
    staleTime: Infinity,
  });
  useEffect(() => {
    client.setQueryData<Draft<T>>(key, (current) =>
      current ? refreshDraft(current, initial, revision) : createDraft(initial, revision),
    );
  }, [client, key, initial, revision]);
  function setValue(update: (value: T) => T) {
    client.setQueryData<Draft<T>>(key, (current = draft) => ({
      ...current,
      value: update(current.value),
    }));
  }
  function reset() {
    client.setQueryData(key, createDraft(initial, revision));
  }
  function reapply() {
    client.setQueryData<Draft<T>>(key, (current = draft) => ({
      ...current,
      baseline: initial,
      revision,
    }));
  }
  function acceptSaved(value: T, savedRevision: number, submitted: T) {
    client.setQueryData<Draft<T>>(key, (current = draft) =>
      saveDraft(current, value, savedRevision, submitted),
    );
  }
  return {
    value: draft.value,
    revision: draft.revision,
    dirty: isDirty(draft),
    newer: revision > draft.revision,
    setValue,
    reset,
    reapply,
    acceptSaved,
  };
}
