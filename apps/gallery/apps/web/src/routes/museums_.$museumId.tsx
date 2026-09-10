import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/museums_/$museumId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/exhibitions/$exhibitionId",
      params: { exhibitionId: params.museumId },
    });
  },
});
