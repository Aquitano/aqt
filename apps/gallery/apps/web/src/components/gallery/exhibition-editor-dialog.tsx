import { Button } from "@aqt/gallery-ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aqt/gallery-ui/components/dialog";
import { Input } from "@aqt/gallery-ui/components/input";
import { Label } from "@aqt/gallery-ui/components/label";
import { Textarea } from "@aqt/gallery-ui/components/textarea";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { useTRPC } from "@/utils/trpc";

export function ExhibitionEditorDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation(trpc.exhibitions.create.mutationOptions());
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [description, setDescription] = useState("");

  const reset = () => {
    setName("");
    setTagline("");
    setDescription("");
  };

  const submit = async () => {
    if (!name.trim()) return;
    const created = await create.mutateAsync({
      name: name.trim(),
      tagline: tagline.trim() || null,
      description: description.trim() || null,
    });
    await queryClient.invalidateQueries(trpc.exhibitions.pathFilter());
    toast.success("Exhibition created");
    reset();
    onOpenChange(false);
    await navigate({
      to: "/exhibitions/$exhibitionId",
      params: { exhibitionId: created.id },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create an exhibition</DialogTitle>
          <DialogDescription>
            Starts with one room you can fill with artworks and walk through in 3D. Add more rooms
            any time.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="exhibition-name">Name</Label>
            <Input
              id="exhibition-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="exhibition-tagline">Tagline</Label>
            <Input
              id="exhibition-tagline"
              placeholder="Shown beneath the title"
              value={tagline}
              onChange={(event) => setTagline(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="exhibition-description">Description</Label>
            <Textarea
              id="exhibition-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={create.isPending || name.trim().length === 0}
          >
            Create exhibition
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
