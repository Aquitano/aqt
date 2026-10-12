import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { ReactNode } from "react";

export const Disclosure = ({
  summary,
  defaultOpen = false,
  children,
}: {
  readonly summary: ReactNode;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
}) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="disclosure">
      <button
        type="button"
        className="disclosure-trigger"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
        {summary}
      </button>
      {open && children}
    </div>
  );
};
