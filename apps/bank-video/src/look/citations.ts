import type { PhotoId } from "./photos";

/**
 * How each image is cited on screen. Every line is built only from that image's title, credit
 * and licence in photos.ts, shortened but not added to.
 */
export const citations = {
  rays: "Crepuscular rays over Chesapeake Bay, NOAA Ship Thomas Jefferson. NOAA Photo Library. Public domain.",
  ledger: "Libro delle Colonne, Genoa, 1485. Photo: User:FA2010, Wikimedia Commons. Public domain.",
  milkyway: "The Milky Way Center Aglow with Dust, PIA03653. NASA/JPL-Caltech. Public domain.",
  notebook:
    "Notebook from the lectures of Herman Mark, 1929. Science History Institute. Public domain.",
  wing: "Culiceta annulata, wing. Enno Merivee. CC0.",
  jupiter:
    "Cassini cylindrical map of Jupiter, PIA07782. NASA/JPL/Space Science Institute. Public domain.",
  type: "Fraktur display type, Schwäbische Zeitung, Wirtschaftsmuseum Ravensburg. Andreas Praefcke. Public domain.",
  iron: "Banded iron formation, Michigan. Wilson44691. Public domain.",
  aurora: "Aurora over the North Pacific from the ISS, iss072e188141. NASA. Public domain.",
  seismogram:
    "Seismometer record of the Apollo 12 Lunar Module impact, S69-59547. NASA Johnson Space Center. Public domain.",
  frost: "Hoarfrost on a branch, Whistler. Erin Frey. CC0.",
  saltflat: "Bonneville Salt Flats with a rainbow. Bureau of Land Management Utah. Public domain.",
  fieldbook:
    "William Foshag's Kaminaljuyu jade field book. Smithsonian Institution. Public domain.",
  gneiss: "Tonalitic gneiss, NMNH 116542-1. Smithsonian, NMNH Mineral Sciences. CC0.",
  lava: "Kilauea summit eruption, fissure fountains, 11 Sept 2023. USGS Hawaiian Volcano Observatory. Public domain.",
  sliderule: "Faber-Castell 2/82 slide rule. Slashme. CC0.",
  agate: "Quartz, var. agate. Smithsonian, NMNH Mineral Sciences. CC0.",
  clouds:
    "Cloud deck from NASA's DC-8 during NAMMA, ARC-2006-ACD06-0135-001. NASA Ames Research Center. Public domain.",
  spectra:
    "Secchi, Le Soleil, plate 3: spectra of star classes III–IV. Science History Institute. Public domain.",
  core: "Listwaenite drill core, Oman. Diorit. CC0.",
  cliffs: "Book Cliffs at dusk, Utah. Bureau of Land Management Utah. Public domain.",
  rowland:
    "Henry A. Rowland, Photographic Map of the Solar Spectrum, NMAH 1989.0082.04. Smithsonian. CC0.",
  fossil:
    "Notogoneus osculus, Fossil Butte National Monument. National Park Service. Public domain.",
  bering:
    "Bering Sea sunset from the Brown Bear, 1960. Harley D. Nygren, NOAA Corps Collection. Public domain.",
  catalogue: "Wooden card catalogue drawers. MarkBuckawicki. CC0.",
  atlantic: "Sunset at sea, NOAA Ship Delaware II. NOAA Photo Library. Public domain.",
  shelf:
    "Books in Bishop White's study, Independence National Historical Park. National Park Service. Public domain.",
  smythii: "The lunar horizon over Mare Smythii, Apollo 11, AS11-44-6553. NASA. Public domain.",
  pacific: "Earth's atmosphere over the Pacific from the ISS, iss074e0089803. NASA. Public domain.",
  sandgate: "Tidal flats at sunset, Sandgate, IMGP4311. John Robert McPherson. CC0.",
  sandgate2: "Tidal flats at sunset, Sandgate, IMGP4312. John Robert McPherson. CC0.",
  apollo8west: "Oblique lunar surface looking west, Apollo 8, AS08-17-2814. NASA. Public domain.",
  apollo8west2: "Oblique lunar surface looking west, Apollo 8, AS08-17-2821. NASA. Public domain.",
  farside: "The far side toward Tsiolkovskiy, Apollo 8, AS08-12-2196. NASA. Public domain.",
  apollo8southwest: "Lunar horizon looking southwest, Apollo 8, AS08-14-2453. NASA. Public domain.",
  tranquility:
    "The lunar surface from the Lunar Module, Apollo 11, AS11-37-5458. NASA. Public domain.",
  apollo11surface: "Lunar surface and horizon, Apollo 11, AS11-40-5881. NASA. Public domain.",
  mound: "A mound on the lunar surface, Apollo 12, AS12-46-6795. NASA. Public domain.",
  apollo12craters: "Craters toward Tsiolkovskiy, Apollo 12, AS12-47-6870. NASA. Public domain.",
  vangent: "Van Gent and Nagaoka craters, Apollo 16, AS16-118-18947. NASA. Public domain.",
  southpacific: "Sun glint on the South Pacific from the ISS, iss063e050668. NASA. Public domain.",
  caspian: "Sun glint on the Caspian Sea from the ISS, iss067e149384. NASA. Public domain.",
  biscay: "Sun glint over the Bay of Biscay from the ISS, iss068e020171. NASA. Public domain.",
  midway: "Sun glint on the Pacific near Midway from the ISS, iss068e036653. NASA. Public domain.",
  okhotsk: "Sun glint on the Sea of Okhotsk from the ISS, iss069e005463. NASA. Public domain.",
  bahamas:
    "Sun glint on the Atlantic east of the Bahamas from the ISS, iss070e052109. NASA. Public domain.",
  westaustralia:
    "Sun glint off Western Australia from the ISS, iss072e145182. NASA. Public domain.",
  southernocean: "Sun glint south of Australia from the ISS, iss073e0107413. NASA. Public domain.",
} satisfies Record<PhotoId, string>;
