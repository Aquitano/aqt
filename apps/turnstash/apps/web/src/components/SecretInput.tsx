import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@aqt/ui/components/input-group";
import { cn } from "cn";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";
import type { ComponentProps } from "react";

export const SecretInput = ({
  className,
  ...props
}: Omit<ComponentProps<typeof InputGroupInput>, "type">) => {
  const [shown, setShown] = useState(false);
  return (
    <InputGroup className={cn("h-8", className)}>
      <InputGroupInput type={shown ? "text" : "password"} {...props} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          aria-label={shown ? "Hide" : "Show"}
          aria-pressed={shown}
          onClick={() => setShown((value) => !value)}
        >
          {shown ? <EyeOffIcon /> : <EyeIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
};
