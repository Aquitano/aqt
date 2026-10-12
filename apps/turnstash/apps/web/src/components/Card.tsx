import type { ReactNode } from "react";

export const Card = ({
  title,
  note,
  children,
}: {
  readonly title: string;
  readonly note?: ReactNode;
  readonly children: ReactNode;
}) => (
  <section className="card">
    <div className="card-head">
      <h2 className="card-title">{title}</h2>
      {note !== undefined && <span className="card-note">{note}</span>}
    </div>
    {children}
  </section>
);
