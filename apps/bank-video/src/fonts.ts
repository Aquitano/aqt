import { cancelRender, continueRender, delayRender } from "remotion";

// oxlint-disable-next-line import/no-unassigned-import -- importing the stylesheet registers the font faces
import "@fontsource-variable/martian-mono/wdth.css";
// oxlint-disable-next-line import/no-unassigned-import -- importing the stylesheet registers the font faces
import "@fontsource-variable/source-serif-4/opsz.css";

/** Holds the first frame until both families are ready, so no frame renders in a fallback font. */
export const loadFonts = () => {
  const waiting = delayRender("Loading fonts");
  Promise.all([
    document.fonts.load('500 20px "Martian Mono Variable"'),
    document.fonts.load('400 20px "Source Serif 4 Variable"'),
  ])
    .then(() => continueRender(waiting))
    .catch(cancelRender);
};
