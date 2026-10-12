import { EnrollRequest } from "@aqt/turnstash-api";
import { Banner, Button, ClipboardText, Dialog, Input, Select } from "@cloudflare/kumo";
import { PlusIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect, Schema } from "effect";
import { useState } from "react";
import type { ChangeEvent } from "react";

import { api } from "../api";
import { Async, RequestFailure } from "../components/Async";
import { MachinesTable } from "../components/Tables";
import { machinesQuery, queryKeys } from "../queries";

const osOptions = [
  { value: "darwin", label: "macOS" },
  { value: "linux", label: "Linux" },
  { value: "win32", label: "Windows" },
];

const isOs = Schema.is(EnrollRequest.fields.os);

const EnrollDialog = () => {
  const queryClient = useQueryClient();
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
    <Dialog.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <Dialog.Trigger render={<Button size="sm" variant="primary" icon={<PlusIcon />} />}>
        Enrol machine
      </Dialog.Trigger>
      <Dialog size="lg" className="p-6">
        <div className="card-head">
          <Dialog.Title className="card-title">Enrol a machine</Dialog.Title>
        </div>

        {enroll.data === undefined ? (
          <div className="stack">
            <Input
              label="Name"
              placeholder="workshop-mbp"
              value={name}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
            />
            <Select<string>
              label="Operating system"
              value={os}
              items={osOptions}
              onValueChange={(next) => {
                if (next !== null && isOs(next)) setOs(next);
              }}
            />
            <Input
              label="Architecture"
              value={arch}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setArch(event.target.value)}
            />
            {enroll.isError && <RequestFailure error={enroll.error} />}
            <div className="row">
              <Button
                variant="primary"
                loading={enroll.isPending}
                disabled={name.trim() === ""}
                onClick={() =>
                  enroll.mutate({ name: name.trim(), os, arch: arch.trim(), agentVersion: "0.0.0" })
                }
              >
                Enrol
              </Button>
              <Dialog.Close render={<Button />}>Cancel</Dialog.Close>
            </div>
          </div>
        ) : (
          <div className="stack">
            <Banner
              variant="alert"
              title="This token is shown once"
              description="Run the command below on the machine now; the archive only keeps its hash."
            />
            <ClipboardText
              text={`turnstash connect --server ${window.location.origin} --machine-id ${enroll.data.machineId} --token ${enroll.data.token}`}
            />
            <dl className="kv">
              <dt>Machine id</dt>
              <dd>{enroll.data.machineId}</dd>
            </dl>
            <div className="row">
              <Dialog.Close render={<Button />}>Done</Dialog.Close>
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  );
};

export const MachinesSettings = () => {
  const machines = useQuery(machinesQuery());

  return (
    <Async query={machines}>
      {(rows) => (
        <MachinesTable rows={rows} title="Machines" note={<EnrollDialog />} platform enrolled />
      )}
    </Async>
  );
};
