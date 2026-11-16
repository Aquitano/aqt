import { Composition } from "remotion";

import { loadFonts } from "../../fonts";
import { fps, height, width } from "../../timeline";
import { ApertureFilm, testDuration, type ApertureName } from "./Aperture";

loadFonts();

const tests: { id: string; aperture: ApertureName }[] = [
  { id: "Square", aperture: "square" },
  { id: "Lens", aperture: "lens" },
  { id: "Slit", aperture: "slit" },
];

export function Root() {
  return (
    <>
      {tests.map((test) => (
        <Composition
          key={test.id}
          id={test.id}
          component={ApertureFilm}
          defaultProps={{ aperture: test.aperture }}
          durationInFrames={testDuration}
          fps={fps}
          width={width}
          height={height}
        />
      ))}
    </>
  );
}
