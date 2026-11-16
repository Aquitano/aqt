import { Composition } from "remotion";

import { Film } from "./Film";
import { loadFonts } from "./fonts";
import { Frieze } from "./look/frieze/Frieze";
import { OrbFilm } from "./look/orbs/OrbFilm";
import { PhotoFilm } from "./look/PhotoFilm";
import { durationInFrames as photoDuration } from "./look/plan";
import { Seam } from "./look/seam/Seam";
import { versions } from "./look/versions";
import { durationInFrames, fps, height, width } from "./timeline";

loadFonts();

const names = { line: "Line", search: "Search", sources: "Sources", cited: "Cited" } as const;

export function Root() {
  return (
    <>
      {versions.map((version) => (
        <Composition
          key={version.id}
          id={names[version.id]}
          component={PhotoFilm}
          defaultProps={{ version }}
          durationInFrames={version.arc.durationInFrames}
          fps={fps}
          width={width}
          height={height}
        />
      ))}
      <Composition
        id="Seam"
        component={Seam}
        durationInFrames={photoDuration}
        fps={fps}
        width={width}
        height={height}
      />
      <Composition
        id="Orbs"
        component={OrbFilm}
        durationInFrames={photoDuration}
        fps={fps}
        width={width}
        height={height}
      />
      <Composition
        id="Frieze"
        component={Frieze}
        durationInFrames={photoDuration}
        fps={fps}
        width={width}
        height={height}
      />
      <Composition
        id="Siglum"
        component={Film}
        durationInFrames={durationInFrames}
        fps={fps}
        width={width}
        height={height}
      />
    </>
  );
}
