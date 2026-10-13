import { Alert, AlertDescription, AlertTitle } from "@aqt/ui/components/alert";
import { Button } from "@aqt/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@aqt/ui/components/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@aqt/ui/components/field";
import { Input } from "@aqt/ui/components/input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { useRef, useState } from "react";

import { Choice, ErrorNotice } from "@/components/library-common";
import { importLibrary } from "@/lib/library-api";

export function LibraryImportForm() {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState("netflix");
  const [account, setAccount] = useState("");
  const [file, setFile] = useState<File>();
  const mutation = useMutation({
    mutationFn: () => {
      if (!file) throw new Error("Choose an export first.");
      return importLibrary(kind, file, account);
    },
    onSuccess: async () => {
      setFile(undefined);
      if (input.current) input.current.value = "";
      await Promise.all([
        client.invalidateQueries({ queryKey: ["library"] }),
        client.invalidateQueries({ queryKey: ["find"] }),
        client.invalidateQueries({ queryKey: ["import-reports"] }),
        client.invalidateQueries({ queryKey: ["stats"] }),
      ]);
    },
  });
  return (
    <Card className="mb-7">
      <CardHeader>
        <CardTitle>Import a media export</CardTitle>
        <CardDescription>
          Preserve source history and playlists alongside your personal tracking.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <FieldGroup className="gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="import-kind">Format</FieldLabel>
                <Choice
                  id="import-kind"
                  label="Import format"
                  value={kind}
                  onChange={(value) => {
                    setKind(value);
                    mutation.reset();
                  }}
                  options={[
                    { value: "netflix", label: "Netflix viewing history (.csv)" },
                    { value: "youtube-media", label: "YouTube Takeout" },
                    { value: "library", label: "Library bundle (.json)" },
                  ]}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="import-account">Account or profile</FieldLabel>
                <Input
                  id="import-account"
                  value={account}
                  onChange={(event) => setAccount(event.target.value)}
                  placeholder="e.g. Thomas"
                />
                <FieldDescription>
                  Use the same name when importing this account again.
                </FieldDescription>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="import-file">Export file</FieldLabel>
              <Input
                ref={input}
                id="import-file"
                type="file"
                required
                accept={
                  kind === "netflix"
                    ? ".csv"
                    : kind === "library"
                      ? ".json"
                      : ".zip,.json,.html,.csv"
                }
                onChange={(event) => {
                  setFile(event.target.files?.[0]);
                  mutation.reset();
                }}
              />
              <FieldDescription>
                {kind === "youtube-media"
                  ? "Upload a Takeout ZIP, watch-history JSON/HTML, or playlist CSV."
                  : kind === "netflix"
                    ? "Netflix provides dates without a time. The original precision is preserved."
                    : "A versioned JSON bundle of library records."}
              </FieldDescription>
            </Field>
          </FieldGroup>
          <div>
            <Button disabled={!file || mutation.isPending}>
              <Upload data-icon="inline-start" />
              {mutation.isPending ? "Importing…" : "Import export"}
            </Button>
          </div>
          {mutation.isError && <ErrorNotice error={mutation.error} />}
          {mutation.isSuccess && (
            <Alert>
              <AlertTitle>Import completed</AlertTitle>
              <AlertDescription>
                <p>
                  {mutation.data.items} items, {mutation.data.activity} activity records,{" "}
                  {mutation.data.collections} collections, {mutation.data.files} files and{" "}
                  {mutation.data.pages} pages processed.
                </p>
                {(mutation.data.skipped ?? 0) > 0 && (
                  <p>{mutation.data.skipped} records skipped.</p>
                )}
                {(mutation.data.ads ?? 0) > 0 && <p>{mutation.data.ads} advertisements skipped.</p>}
                {[...new Set(mutation.data.diagnostics ?? [])].map((diagnostic) => (
                  <p key={diagnostic}>{diagnostic}</p>
                ))}
              </AlertDescription>
            </Alert>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
