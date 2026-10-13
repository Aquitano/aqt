import type { EnrollRequest } from "@aqt/turnstash-api";
import { Alert, AlertDescription, AlertTitle } from "@aqt/ui/components/alert";
import { Button } from "@aqt/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@aqt/ui/components/dialog";
import { Field, FieldGroup, FieldLabel } from "@aqt/ui/components/field";
import { Input } from "@aqt/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aqt/ui/components/select";
import { Spinner } from "@aqt/ui/components/spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useId, useState } from "react";

import { api } from "../api";
import { Async, RequestFailure } from "../components/Async";
import { CopyField } from "../components/CopyField";
import { MachinesTable } from "../components/Tables";
import { machinesQuery, queryKeys } from "../queries";

const osOptions: ReadonlyArray<{ readonly value: EnrollRequest["os"]; readonly label: string }> = [
  { value: "darwin", label: "macOS" },
  { value: "linux", label: "Linux" },
  { value: "win32", label: "Windows" },
];

const EnrollDialog = () => {
  const queryClient = useQueryClient();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [os, setOs] = useState<EnrollRequest["os"]>("darwin");
  const [arch, setArch] = useState("arm64");

  const enroll = useMutation({
    mutationFn: (input: EnrollRequest) => Effect.runPromise(api.admin.enroll({ payload: input })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.machines }),
  });

  const close = () => {
    setOpen(false);
    enroll.reset();
    setName("");
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogTrigger render={<Button size="sm" />}>
        <PlusIcon data-icon="inline-start" />
        Enrol machine
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Enrol a machine</DialogTitle>
        </DialogHeader>

        {enroll.data === undefined ? (
          <>
            <FieldGroup className="gap-4">
              <Field className="gap-2">
                <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                <Input
                  id={`${id}-name`}
                  placeholder="workshop-mbp"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field className="gap-2">
                <FieldLabel htmlFor={`${id}-os`}>Operating system</FieldLabel>
                <Select
                  items={osOptions}
                  value={os}
                  onValueChange={(next) => {
                    if (next !== null) setOs(next);
                  }}
                >
                  <SelectTrigger id={`${id}-os`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {osOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field className="gap-2">
                <FieldLabel htmlFor={`${id}-arch`}>Architecture</FieldLabel>
                <Input
                  id={`${id}-arch`}
                  value={arch}
                  onChange={(event) => setArch(event.target.value)}
                />
              </Field>
            </FieldGroup>
            {enroll.isError && <RequestFailure error={enroll.error} />}
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button
                disabled={enroll.isPending || name.trim() === ""}
                onClick={() =>
                  enroll.mutate({ name: name.trim(), os, arch: arch.trim(), agentVersion: "0.0.0" })
                }
              >
                {enroll.isPending && <Spinner data-icon="inline-start" />}
                Enrol
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <Alert variant="warning">
              <TriangleAlertIcon />
              <AlertTitle>This token is shown once</AlertTitle>
              <AlertDescription>
                Run the command below on the machine now; the archive only keeps its hash.
              </AlertDescription>
            </Alert>
            <CopyField
              label="Connect command"
              text={`turnstash connect --server ${window.location.origin} --machine-id ${enroll.data.machineId} --token ${enroll.data.token}`}
            />
            <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-5 gap-y-1.5">
              <dt className="text-muted-foreground">Machine id</dt>
              <dd className="wrap-anywhere">{enroll.data.machineId}</dd>
            </dl>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Done</DialogClose>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export const MachinesSettings = () => {
  const machines = useQuery(machinesQuery());

  return (
    <Async query={machines}>
      {(rows) => (
        <MachinesTable rows={rows} title="Machines" action={<EnrollDialog />} platform enrolled />
      )}
    </Async>
  );
};
