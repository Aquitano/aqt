import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

export const tokenTotals = [
  { value: "inOut", label: "In + out" },
  { value: "withCache", label: "With cache" },
] as const;

type TokenTotal = (typeof tokenTotals)[number]["value"];

const isTokenTotal = (value: string | null): value is TokenTotal =>
  tokenTotals.some((total) => total.value === value);

const TokenTotalContext = createContext<readonly [TokenTotal, (value: string) => void] | null>(
  null,
);

const tokenTotalKey = "cb_token_total";

const savedTokenTotal = (): TokenTotal => {
  try {
    const stored = localStorage.getItem(tokenTotalKey);
    return isTokenTotal(stored) ? stored : "inOut";
  } catch {
    // Storage may be blocked; the default applies.
    return "inOut";
  }
};

export const TokenTotalProvider = ({ children }: { readonly children: ReactNode }) => {
  const [total, setTotal] = useState(savedTokenTotal);
  const choose = useCallback((value: string) => {
    if (!isTokenTotal(value)) return;
    setTotal(value);
    try {
      localStorage.setItem(tokenTotalKey, value);
    } catch {
      // The choice still applies for this page load.
    }
  }, []);
  const value = useMemo(() => [total, choose] as const, [total, choose]);
  return <TokenTotalContext value={value}>{children}</TokenTotalContext>;
};

export const useTokenTotal = () => {
  const settings = useContext(TokenTotalContext);
  if (settings === null) throw new Error("useTokenTotal was called outside TokenTotalProvider");
  return settings;
};
