import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import { Predicate } from "effect";
import { useMemo, useState } from "react";

export interface SortState<K extends string> {
  readonly key: K;
  readonly direction: "asc" | "desc";
}

type Comparable = string | number | null | undefined;

const compare = (a: Comparable, b: Comparable): number => {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return Predicate.isNumber(a) && Predicate.isNumber(b)
    ? a - b
    : String(a).localeCompare(String(b));
};

export const useSort = <A, K extends string>(
  rows: ReadonlyArray<A>,
  initial: SortState<K>,
  pick: (row: A, key: K) => Comparable,
) => {
  const [sort, setSort] = useState<SortState<K>>(initial);
  const sorted = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          (sort.direction === "asc" ? 1 : -1) * compare(pick(a, sort.key), pick(b, sort.key)),
      ),
    [rows, sort, pick],
  );
  const toggle = (key: K) =>
    setSort((current) => ({
      key,
      direction:
        current.key === key
          ? current.direction === "asc"
            ? "desc"
            : "asc"
          : key === initial.key
            ? initial.direction
            : "desc",
    }));
  return { sorted, sort, toggle };
};

export const SortHeader = <K extends string>({
  label,
  column,
  sort,
  onToggle,
  numeric = false,
}: {
  readonly label: string;
  readonly column: K;
  readonly sort: SortState<K>;
  readonly onToggle: (key: K) => void;
  readonly numeric?: boolean;
}) => {
  const active = sort.key === column;
  return (
    <th
      className={numeric ? "num" : undefined}
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className={active ? "sort is-active" : "sort"}
        onClick={() => onToggle(column)}
      >
        {label}
        {active &&
          (sort.direction === "asc" ? <CaretUpIcon size={11} /> : <CaretDownIcon size={11} />)}
      </button>
    </th>
  );
};
