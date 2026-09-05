import { Button } from "@aqt-gallery/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aqt-gallery/ui/components/dialog";
import { Input } from "@aqt-gallery/ui/components/input";
import { Label } from "@aqt-gallery/ui/components/label";
import { Textarea } from "@aqt-gallery/ui/components/textarea";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { useTRPC } from "@/utils/trpc";

export function MuseumEditorDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createMuseum = useMutation(trpc.museum.createMuseum.mutationOptions());
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
    const created = await createMuseum.mutateAsync({
      name: name.trim(),
      tagline: tagline.trim() || null,
      description: description.trim() || null,
    });
    await queryClient.invalidateQueries();
    toast.success("Museum created");
    reset();
    onOpenChange(false);
    if (created) {
      navigate({
        to: "/museums/$museumId",
        params: { museumId: created.id },
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create a museum</DialogTitle>
          <DialogDescription>
            A building of several rooms you can fill with artworks and walk through in 3D.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="museum-name">Name</Label>
            <Input
              id="museum-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="museum-tagline">Tagline</Label>
            <Input
              id="museum-tagline"
              placeholder="Shown beneath the title"
              value={tagline}
              onChange={(event) => setTagline(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="museum-description">Description</Label>
            <Textarea
              id="museum-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={createMuseum.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={createMuseum.isPending || name.trim().length === 0}
          >
            Create museum
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
