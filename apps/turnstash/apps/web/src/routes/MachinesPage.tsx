import { useQuery } from "@tanstack/react-query";

import { Async } from "../components/Async";
import { Page, PageHead } from "../components/Page";
import { MachinesTable } from "../components/Tables";
import { machinesQuery } from "../queries";

export const MachinesPage = () => {
  const machines = useQuery(machinesQuery());

  return (
    <Page>
      <PageHead title="Machines" />
      <Async query={machines}>
        {(rows) => (
          <MachinesTable
            rows={rows}
            title="Enrolled machines"
            note={`${rows.length} machines, all-time totals`}
            platform
            enrolled
            conversations
            agent="inline"
          />
        )}
      </Async>
    </Page>
  );
};
