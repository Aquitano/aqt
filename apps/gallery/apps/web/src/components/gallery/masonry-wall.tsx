import type { ReactNode } from "react";

export function MasonryWall({ children }: { children: ReactNode }) {
  return <div className="masonry-wall">{children}</div>;
}

export function WallEmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="gallery-empty-state">
      <h1>{title}</h1>
      {children}
    </div>
  );
}
