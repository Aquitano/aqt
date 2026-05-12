import type { ReactNode } from "react";
import { ErrorNotice } from "./ErrorNotice";
import type { ApiResult } from "@/lib/types";

type DataSectionProps<T> = {
  title: string;
  result: ApiResult<T>;
  children: (data: T) => ReactNode;
};

export function DataSection<T>({ title, result, children }: DataSectionProps<T>) {
  return (
    <section className="data-section">
      <div className="section-heading">
        <h2>{title}</h2>
      </div>
      <ErrorNotice result={result} />
      {result.ok ? children(result.data) : null}
    </section>
  );
}
