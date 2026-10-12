import { useQuery } from "@tanstack/react-query";

import { Async } from "../components/Async";
import { MachinesTable } from "../components/Tables";
import { machinesQuery } from "../queries";

export const MachinesPage = () => {
  const machines = useQuery(machinesQuery());

  return (
    <main className="main">
      <div className="page-head">
        <h1 className="page-title">Machines</h1>
      </div>
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
    </main>
  );
};
