import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@aqt/ui/components/alert-dialog";
import { useState, type ReactElement, type ReactNode } from "react";

export const ConfirmAction = ({
  trigger,
  children,
  disabled = false,
  title,
  description,
  actionLabel,
  onConfirm,
}: {
  readonly trigger: ReactElement;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly onConfirm: () => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger disabled={disabled} render={trigger}>
        {children}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={disabled}
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
