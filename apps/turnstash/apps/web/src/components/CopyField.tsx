import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@aqt/ui/components/input-group";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

export const CopyField = ({ text, label }: { readonly text: string; readonly label: string }) => {
  const [result, setResult] = useState<{ readonly text: string; readonly success: boolean } | null>(
    null,
  );
  const copied = result?.text === text && result.success;
  const failed = result?.text === text && !result.success;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <InputGroup>
        <InputGroupInput
          readOnly
          value={text}
          aria-label={label}
          className="font-mono text-xs"
          onFocus={(event) => event.currentTarget.select()}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label={copied ? "Copied" : `Copy ${label.toLowerCase()}`}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                setResult({ text, success: true });
              } catch {
                setResult({ text, success: false });
              }
            }}
          >
            {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <p role="status" className={failed ? "text-xs text-muted-foreground" : "sr-only"}>
        {failed
          ? "Could not copy. Select the field and copy it manually."
          : copied
            ? "Copied to clipboard."
            : ""}
      </p>
    </div>
  );
};
