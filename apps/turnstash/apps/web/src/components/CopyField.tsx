import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@aqt/ui/components/input-group";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

export const CopyField = ({ text, label }: { readonly text: string; readonly label: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <InputGroup>
      <InputGroupInput readOnly value={text} aria-label={label} className="font-mono text-xs" />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          aria-label={copied ? "Copied" : `Copy ${label.toLowerCase()}`}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => setCopied(true));
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
};
