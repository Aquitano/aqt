import { Select } from "@cloudflare/kumo";

import { Card } from "../components/Card";
import { tokenTotals, useTokenTotal } from "../token-total";

export const DisplaySettings = () => {
  const [tokenTotal, chooseTokenTotal] = useTokenTotal();
  return (
    <Card title="Token totals">
      <div className="stack">
        <p className="muted">
          Choose whether dashboard token totals include cached tokens. Saved in this browser.
        </p>
        <Select<string>
          label="Count tokens"
          size="sm"
          value={tokenTotal}
          items={[...tokenTotals]}
          onValueChange={(value) => {
            if (value !== null) chooseTokenTotal(value);
          }}
        />
      </div>
    </Card>
  );
};
