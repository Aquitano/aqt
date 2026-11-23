import { Composition } from "remotion";

import { loadFonts } from "../../fonts";
import { fps, height, width } from "../../timeline";
import { durationInFrames } from "../plan";
import { OrbFilm } from "./OrbFilm";

loadFonts();

export function Root() {
  return (
    <Composition
      id="Orbs"
      component={OrbFilm}
      durationInFrames={durationInFrames}
      fps={fps}
      width={width}
      height={height}
    />
  );
}
