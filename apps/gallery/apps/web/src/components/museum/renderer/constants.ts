/** Painting geometry (metres). The frame is a solid slab on the wall; the
 * canvas floats CANVAS_LIFT in front of its face, the inner lip just proud of
 * the slab between the two. */
export const FRAME_BORDER = 0.085;
export const FRAME_DEPTH = 0.075;
export const CANVAS_LIFT = 0.052;
export const LIP_Z = FRAME_DEPTH + 0.004;
export const CANVAS_Z = FRAME_DEPTH + 0.046;

/** How far the track light is pulled into the room from the wall, and how far
 * below the ceiling its housing hangs. Shared by the cosmetic housing and the
 * pooled spotlight so the light emanates from exactly the housing. */
export const TRACK_LIGHT_REACH = 2.1;
export const TRACK_LIGHT_DROP = 0.12;

/** Distance the fog goes fully opaque, and the camera far plane that culls
 * just beyond it. Bounding both keeps per-frame fillrate flat no matter how
 * large the museum is; a single deep room plus a peek into the next fits. */
export const FOG_FAR = 40;
export const CAMERA_FAR = 46;
export const FOG_NEAR = 12;

export const CEILING_COLOR = "#1b1813";
export const DOORFRAME_COLOR = "#191510";
export const BENCH_TOP_COLOR = "#2b211a";
export const BENCH_LEG_COLOR = "#15110d";
export const FRAME_ANTIQUE_COLOR = "#a07d36";
export const FRAME_DARK_COLOR = "#241a12";
export const FRAME_GLOW_COLOR = "#d8b35a";
export const LIP_COLOR = "#0c0a08";
export const PLAQUE_COLOR = "#d9d2c4";
export const PLAQUE_TITLE_COLOR = "#23201b";
export const PLAQUE_SUBTITLE_COLOR = "#4d463c";
export const ROOM_LABEL_COLOR = "#d8cfbf";
export const HOUSING_COLOR = "#15130f";
/** Dark canvas placeholder shown until a painting's first texture lands. */
export const LOADING_CANVAS_COLOR = "#494439";
export const MISSING_PLATE_COLOR = "#26231f";
export const MISSING_LABEL_COLOR = "#8d857a";

export const PLAQUE_WIDTH = 0.42;
export const PLAQUE_HEIGHT = 0.18;
export const PLAQUE_TEXT_WIDTH = 0.36;
export const PLAQUE_TEXT_HEIGHT = 0.18;
