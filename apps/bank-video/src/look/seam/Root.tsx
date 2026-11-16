import { Composition } from "remotion";

import { loadFonts } from "../../fonts";
import { fps, height, width } from "../../timeline";
import { durationInFrames } from "../plan";
import { Seam } from "./Seam";

loadFonts();

export function Root() {
  return (
    <Composition
      id="Seam"
      component={Seam}
      durationInFrames={durationInFrames}
      fps={fps}
      width={width}
      height={height}
    />
  );
}
