import { Composition } from "remotion";

import { loadFonts } from "../../fonts";
import { fps, height, width } from "../../timeline";
import { durationInFrames } from "../plan";
import { Frieze } from "./Frieze";

loadFonts();

export function Root() {
  return (
    <Composition
      id="Frieze"
      component={Frieze}
      durationInFrames={durationInFrames}
      fps={fps}
      width={width}
      height={height}
    />
  );
}
