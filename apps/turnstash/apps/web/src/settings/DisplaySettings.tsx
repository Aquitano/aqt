import { LabeledSelect } from "../components/LabeledSelect";
import { Section } from "../components/Section";
import { tokenTotals, useTokenTotal } from "../token-total";

export const DisplaySettings = () => {
  const [tokenTotal, chooseTokenTotal] = useTokenTotal();
  return (
    <Section title="Token totals">
      <div className="flex flex-col gap-6 pt-1.5">
        <p className="text-xs text-muted-foreground">
          Choose whether dashboard token totals include cached tokens. Saved in this browser.
        </p>
        <LabeledSelect
          label="Count tokens"
          className="w-36"
          value={tokenTotal}
          options={tokenTotals}
          onChange={chooseTokenTotal}
        />
      </div>
    </Section>
  );
};
