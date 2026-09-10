/**
 * Seeds the public exhibition content: multi-room museums, single-room
 * exhibitions and artist collections, with their artists, artworks and
 * placements.
 *
 * Idempotent: deletes previously seeded rows (deterministic ids/slugs)
 * before re-inserting. Run from packages/db:
 *
 *   bun --env-file=../../apps/server/.env src/scripts/seed-museum.ts
 */
import { inArray } from "drizzle-orm";

import { db } from "../index";
import {
  type ExhibitionKind,
  exhibition,
  type PlacementWall,
  placement,
  room,
} from "../schema/exhibition";
import { artist, artwork } from "../schema/gallery";

const CURATOR_ID = "system-curator";

/** Source URL stored in the DB. The API server proxies and caches these —
 * the browser never fetches Wikimedia directly. */
function commonsUrl(file: string, width: number) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}`;
}

type ArtistSeed = {
  slug: string;
  name: string;
  bio: string;
  birthYear: number;
  deathYear: number;
  nationality: string;
};

const artists: ArtistSeed[] = [
  {
    slug: "claude-monet",
    name: "Claude Monet",
    bio: "Founder of French Impressionism, obsessed with capturing the changing qualities of natural light — often painting the same subject dozens of times at different hours.",
    birthYear: 1840,
    deathYear: 1926,
    nationality: "French",
  },
  {
    slug: "pierre-auguste-renoir",
    name: "Pierre-Auguste Renoir",
    bio: "Impressionist celebrated for luminous scenes of leisure and conviviality; he kept painting through crippling arthritis with brushes strapped to his hands.",
    birthYear: 1841,
    deathYear: 1919,
    nationality: "French",
  },
  {
    slug: "gustave-caillebotte",
    name: "Gustave Caillebotte",
    bio: "Painter and engineer of the new Paris, and a wealthy patron whose collection became the core of the French national Impressionist holdings.",
    birthYear: 1848,
    deathYear: 1894,
    nationality: "French",
  },
  {
    slug: "georges-seurat",
    name: "Georges Seurat",
    bio: "Inventor of pointillism, building shimmering scenes from millions of tiny dots of pure colour grounded in optical science.",
    birthYear: 1859,
    deathYear: 1891,
    nationality: "French",
  },
  {
    slug: "vincent-van-gogh",
    name: "Vincent van Gogh",
    bio: "Post-Impressionist who produced over 2,000 works in a single decade, selling almost nothing in his lifetime yet reshaping the course of modern art.",
    birthYear: 1853,
    deathYear: 1890,
    nationality: "Dutch",
  },
  {
    slug: "edvard-munch",
    name: "Edvard Munch",
    bio: "Norwegian Symbolist whose raw images of anxiety, love and death anticipated Expressionism.",
    birthYear: 1863,
    deathYear: 1944,
    nationality: "Norwegian",
  },
  {
    slug: "johannes-vermeer",
    name: "Johannes Vermeer",
    bio: "Master of quiet domestic light from Delft; only about 36 paintings survive, each one slow, deliberate and luminous.",
    birthYear: 1632,
    deathYear: 1675,
    nationality: "Dutch",
  },
  {
    slug: "rembrandt-van-rijn",
    name: "Rembrandt van Rijn",
    bio: "The towering figure of the Dutch Golden Age, unmatched in his psychological depth and command of light and shadow.",
    birthYear: 1606,
    deathYear: 1669,
    nationality: "Dutch",
  },
  {
    slug: "pieter-bruegel-the-elder",
    name: "Pieter Bruegel the Elder",
    bio: "Flemish Renaissance master of landscape and peasant life, observing the world with equal parts tenderness and wit.",
    birthYear: 1525,
    deathYear: 1569,
    nationality: "Flemish",
  },
  {
    slug: "sandro-botticelli",
    name: "Sandro Botticelli",
    bio: "Florentine painter of the Medici circle whose graceful mythologies defined the ideal beauty of the Early Renaissance.",
    birthYear: 1445,
    deathYear: 1510,
    nationality: "Italian",
  },
  {
    slug: "leonardo-da-vinci",
    name: "Leonardo da Vinci",
    bio: "Painter, engineer, anatomist and the archetypal Renaissance polymath; he finished few paintings, and each became a legend.",
    birthYear: 1452,
    deathYear: 1519,
    nationality: "Italian",
  },
  {
    slug: "caspar-david-friedrich",
    name: "Caspar David Friedrich",
    bio: "German Romantic who turned landscape into a mirror of the soul, placing solitary figures before vast, indifferent nature.",
    birthYear: 1774,
    deathYear: 1840,
    nationality: "German",
  },
  {
    slug: "katsushika-hokusai",
    name: "Katsushika Hokusai",
    bio: "Japanese ukiyo-e master who signed himself 'the old man mad about painting' and worked relentlessly into his ninth decade.",
    birthYear: 1760,
    deathYear: 1849,
    nationality: "Japanese",
  },
  {
    slug: "gustav-klimt",
    name: "Gustav Klimt",
    bio: "Leader of the Vienna Secession whose Golden Period fused portraiture, ornament and real gold leaf.",
    birthYear: 1862,
    deathYear: 1918,
    nationality: "Austrian",
  },
];

type ArtworkSeed = {
  slug: string;
  title: string;
  artistSlug: string;
  year: string;
  medium: string;
  /** Physical size as "height × width cm" — drives credible 3D scale. */
  dimensions: string;
  description: string;
  story: string;
  funFacts: string[];
  file: string;
  imageWidth: number;
  imageHeight: number;
};

const artworks: ArtworkSeed[] = [
  {
    slug: "impression-sunrise",
    title: "Impression, Sunrise",
    artistSlug: "claude-monet",
    year: "1872",
    medium: "Oil on canvas",
    dimensions: "48 × 63 cm",
    description:
      "An orange sun burns through the morning haze over the port of Le Havre, its reflection broken into a few decisive strokes on the water between silhouetted boats and cranes.",
    story:
      "Shown at the first independent exhibition of 1874, the painting provoked critic Louis Leroy to sneer that it was merely an 'impression'. The insult stuck — and gave the entire Impressionist movement its name.",
    funFacts: [
      "The painting that accidentally named Impressionism.",
      "It was stolen from the Musée Marmottan in 1985 and recovered five years later in Corsica.",
      "Astrophysicists have dated the exact scene to around 7:35 am on 13 November 1872.",
    ],
    file: "Claude_Monet,_Impression,_soleil_levant.jpg",
    imageWidth: 1600,
    imageHeight: 1245,
  },
  {
    slug: "woman-with-a-parasol",
    title: "Woman with a Parasol — Madame Monet and Her Son",
    artistSlug: "claude-monet",
    year: "1875",
    medium: "Oil on canvas",
    dimensions: "100 × 81 cm",
    description:
      "Camille Monet stands on a windswept rise, her veil and dress streaming, while young Jean watches from the grass below. The view looks up at her against a sky of rushing clouds.",
    story:
      "Painted outdoors in a single session of a few hours, it is less a portrait than a study of wind, light and a fleeting glance — the figures caught as if by a snapshot decades before the snapshot existed.",
    funFacts: [
      "Monet painted a deliberately faceless companion version eleven years later, using his stepdaughter Suzanne as the model.",
      "The low viewpoint makes the viewer feel like a third walker on the hill.",
    ],
    file: "Claude_Monet_-_Woman_with_a_Parasol_-_Madame_Monet_and_Her_Son_-_Google_Art_Project.jpg",
    imageWidth: 6001,
    imageHeight: 7455,
  },
  {
    slug: "dance-at-le-moulin-de-la-galette",
    title: "Dance at Le Moulin de la Galette",
    artistSlug: "pierre-auguste-renoir",
    year: "1876",
    medium: "Oil on canvas",
    dimensions: "131 × 175 cm",
    description:
      "A Sunday afternoon dance in the open courtyard of a Montmartre windmill-turned-dancehall, with dappled light falling through the trees onto a crowd of dancers, drinkers and friends.",
    story:
      "Renoir hauled the large canvas to the Moulin de la Galette and persuaded his friends to model so he could paint the scene in place, chasing the spots of sunlight that flicker across straw hats and jackets.",
    funFacts: [
      "A smaller version sold in 1990 for over $78 million, briefly among the most expensive paintings ever auctioned.",
      "Many of the 'dancers' are identifiable painters and writers from Renoir's circle.",
    ],
    file: "Auguste_Renoir_-_Dance_at_Le_Moulin_de_la_Galette_-_Google_Art_Project.jpg",
    imageWidth: 40869,
    imageHeight: 30379,
  },
  {
    slug: "luncheon-of-the-boating-party",
    title: "Luncheon of the Boating Party",
    artistSlug: "pierre-auguste-renoir",
    year: "1881",
    medium: "Oil on canvas",
    dimensions: "130 × 173 cm",
    description:
      "Friends linger over the remains of lunch on a restaurant balcony above the Seine, awnings glowing orange, glasses half full, conversations crossing in every direction.",
    story:
      "Painted on the terrace of the Maison Fournaise at Chatou, it gathers fourteen of Renoir's real friends. The young woman cooing at a little dog is Aline Charigot — who would later become his wife.",
    funFacts: [
      "All fourteen figures have been identified, from an actress to an art historian to the restaurant owner's daughter.",
      "Duncan Phillips bought it in 1923 and it remains the star of The Phillips Collection in Washington.",
    ],
    file: "Pierre-Auguste_Renoir_-_Luncheon_of_the_Boating_Party_-_Google_Art_Project.jpg",
    imageWidth: 9025,
    imageHeight: 6684,
  },
  {
    slug: "paris-street-rainy-day",
    title: "Paris Street; Rainy Day",
    artistSlug: "gustave-caillebotte",
    year: "1877",
    medium: "Oil on canvas",
    dimensions: "212 × 276 cm",
    description:
      "Elegant Parisians cross a rain-slicked intersection of the newly rebuilt city under a forest of umbrellas, the cobblestones gleaming with reflected grey light.",
    story:
      "Caillebotte painted Haussmann's modern Paris with an almost photographic eye: the cropped figure at the right edge and the plunging perspective feel like a snapshot taken a generation before street photography existed.",
    funFacts: [
      "Caillebotte was independently wealthy and quietly bankrolled his Impressionist friends, buying their unsold canvases.",
      "His bequest of those canvases became the core of France's national Impressionist collection.",
    ],
    file: "Gustave_Caillebotte_-_Paris_Street;_Rainy_Day_-_Google_Art_Project.jpg",
    imageWidth: 5982,
    imageHeight: 4531,
  },
  {
    slug: "a-sunday-on-la-grande-jatte",
    title: "A Sunday on La Grande Jatte",
    artistSlug: "georges-seurat",
    year: "1884–1886",
    medium: "Oil on canvas",
    dimensions: "207.5 × 308 cm",
    description:
      "Parisians at leisure on an island in the Seine, frozen in serene, almost Egyptian profiles — the whole scene built from countless tiny dots of pure, unmixed colour.",
    story:
      "Seurat spent about two years on the painting, making over sixty studies and applying millions of dots so that the viewer's eye, not the palette, would do the mixing. It became the manifesto of pointillism.",
    funFacts: [
      "Seurat later added a painted border of dots so the frame would not cut the colour vibration short.",
      "The painting inspired the Sondheim musical 'Sunday in the Park with George'.",
    ],
    file: "A_Sunday_on_La_Grande_Jatte,_Georges_Seurat,_1884.jpg",
    imageWidth: 20000,
    imageHeight: 13313,
  },
  {
    slug: "the-starry-night",
    title: "The Starry Night",
    artistSlug: "vincent-van-gogh",
    year: "1889",
    medium: "Oil on canvas",
    dimensions: "73.7 × 92.1 cm",
    description:
      "A night sky in full turbulence — eleven stars, a crescent moon and the Milky Way churn above a sleeping village, while a cypress flames up into the sky like dark fire.",
    story:
      "Van Gogh painted it in June 1889 from his room in the asylum at Saint-Rémy-de-Provence, combining the view from his window before sunrise with a village partly drawn from imagination. He mentioned it almost dismissively in letters, considering it a failed 'study'.",
    funFacts: [
      "The brightest 'star' beside the cypress is actually the planet Venus, which really was visible that June.",
      "Physicists have found that its swirls closely match the mathematics of real turbulent flow.",
      "It has hung at MoMA in New York since 1941 and is arguably the most recognised night sky ever painted.",
    ],
    file: "Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg",
    imageWidth: 44567,
    imageHeight: 35291,
  },
  {
    slug: "cafe-terrace-at-night",
    title: "Café Terrace at Night",
    artistSlug: "vincent-van-gogh",
    year: "1888",
    medium: "Oil on canvas",
    dimensions: "80.7 × 65.3 cm",
    description:
      "A gaslit café terrace glows gold against a deep blue Arles night, with diners under the awning and a street that recedes beneath a sky crowded with stars.",
    story:
      "Painted on location over several nights in the Place du Forum, it was Van Gogh's first attempt at the starry skies that would obsess him. 'The night is more alive and more richly coloured than the day,' he wrote to his sister.",
    funFacts: [
      "There is not a single stroke of black in the entire night scene.",
      "The café still exists in Arles and now trades, inevitably, on the painting.",
    ],
    file: "Vincent_Willem_van_Gogh_-_Cafe_Terrace_at_Night_(Yorck).jpg",
    imageWidth: 2348,
    imageHeight: 2945,
  },
  {
    slug: "wheatfield-with-crows",
    title: "Wheatfield with Crows",
    artistSlug: "vincent-van-gogh",
    year: "1890",
    medium: "Oil on canvas",
    dimensions: "50.5 × 103 cm",
    description:
      "A stormy sky presses down on a golden wheatfield as a flock of crows scatters upward; three paths diverge and none of them clearly leads anywhere.",
    story:
      "Painted in Auvers-sur-Oise in July 1890, in the last weeks of Van Gogh's life. He described wheatfields under troubled skies expressing 'sadness and extreme loneliness' — but also said the canvases would tell 'what I cannot say in words: how healthy and invigorating I find the countryside.'",
    funFacts: [
      "Often called his last painting, though scholars believe several works came after it.",
      "The unusual double-square format was one Van Gogh used repeatedly that final summer.",
    ],
    file: "Vincent_van_Gogh_-_Wheatfield_with_crows_-_Google_Art_Project.jpg",
    imageWidth: 3508,
    imageHeight: 1669,
  },
  {
    slug: "irises",
    title: "Irises",
    artistSlug: "vincent-van-gogh",
    year: "1889",
    medium: "Oil on canvas",
    dimensions: "71 × 93 cm",
    description:
      "A bed of violet-blue irises surges diagonally across the canvas, each bloom drawn with the flowing, cropped elegance of a Japanese print.",
    story:
      "Van Gogh began it within his first week at the Saint-Rémy asylum, calling it 'the lightning conductor for my illness' — working from nature kept the darkness at bay. His brother Theo submitted it to the Salon des Indépendants that autumn.",
    funFacts: [
      "In 1987 it sold for $53.9 million, briefly the most expensive painting ever sold.",
      "Among the violet crowd there is exactly one white iris.",
    ],
    file: "Irises-Vincent_van_Gogh.jpg",
    imageWidth: 11516,
    imageHeight: 8801,
  },
  {
    slug: "almond-blossom",
    title: "Almond Blossom",
    artistSlug: "vincent-van-gogh",
    year: "1890",
    medium: "Oil on canvas",
    dimensions: "73.3 × 92.4 cm",
    description:
      "Branches of white almond blossom open against a clear turquoise sky — a painting of pure renewal, composed like a Japanese woodblock print.",
    story:
      "Van Gogh painted it as a gift for his newborn nephew and namesake, Vincent Willem, to hang above the baby's bed. 'It is perhaps the best, most patiently worked thing I had done,' he wrote from Saint-Rémy.",
    funFacts: [
      "The nephew it was painted for grew up to found the Van Gogh Museum in Amsterdam.",
      "Almond trees are among the first to flower in Provence — a symbol of early spring and new life.",
    ],
    file: "Vincent_van_Gogh_-_Almond_blossom_-_Google_Art_Project.jpg",
    imageWidth: 3139,
    imageHeight: 2480,
  },
  {
    slug: "the-scream",
    title: "The Scream",
    artistSlug: "edvard-munch",
    year: "1893",
    medium: "Oil, tempera and pastel on cardboard",
    dimensions: "91 × 73.5 cm",
    description:
      "A hairless figure on a bridge clutches its head as the sky behind the Oslofjord curdles into bands of blood-orange; two walkers continue on, oblivious.",
    story:
      "Munch recalled walking at sunset when 'the sky turned blood red... and I sensed an infinite scream passing through nature.' The figure does not scream — it shields itself from the scream of the world.",
    funFacts: [
      "A tiny pencil inscription on this version — 'Can only have been painted by a madman' — was confirmed in 2021 to be Munch's own handwriting.",
      "Munch made four painted/pastel versions; two have been stolen (and recovered) in separate heists.",
    ],
    file: "Edvard_Munch,_1893,_The_Scream,_oil,_tempera_and_pastel_on_cardboard,_91_x_73_cm,_National_Gallery_of_Norway.jpg",
    imageWidth: 3223,
    imageHeight: 4000,
  },
  {
    slug: "girl-with-a-pearl-earring",
    title: "Girl with a Pearl Earring",
    artistSlug: "johannes-vermeer",
    year: "c. 1665",
    medium: "Oil on canvas",
    dimensions: "44.5 × 39 cm",
    description:
      "A girl turns over her shoulder out of deep shadow, lips parted, wearing an exotic blue-and-gold turban and a single improbably large pearl.",
    story:
      "Not a portrait at all but a 'tronie' — a study of a type and an expression. Her identity is unknown, which is precisely what lets four centuries of viewers imagine she has just turned to look at them.",
    funFacts: [
      "At an 1881 auction it sold for just two guilders plus buyer's premium.",
      "Research suggests the 'pearl' may be polished tin or glass — real pearls that size barely exist.",
      "It is often called 'the Mona Lisa of the North'.",
    ],
    file: "Johannes_Vermeer_(1632-1675)_-_The_Girl_With_The_Pearl_Earring_(1665).jpg",
    imageWidth: 1861,
    imageHeight: 2663,
  },
  {
    slug: "the-milkmaid",
    title: "The Milkmaid",
    artistSlug: "johannes-vermeer",
    year: "c. 1658",
    medium: "Oil on canvas",
    dimensions: "45.5 × 41 cm",
    description:
      "A kitchen maid pours a thin braid of milk from a jug, utterly absorbed; daylight from the window catches the bread crust, the brass, the cool plaster wall.",
    story:
      "Vermeer monumentalises a moment of domestic work, painting the maid with the gravity usually reserved for saints. Tiny raised dots of paint make the bread sparkle — his signature 'pointillé' light.",
    funFacts: [
      "A foot warmer sits on the floor behind her — a quiet emblem of warmth and desire in Dutch genre painting.",
      "Only around 36 paintings by Vermeer survive in the entire world.",
    ],
    file: "Johannes_Vermeer_-_Het_melkmeisje_-_Google_Art_Project.jpg",
    imageWidth: 4000,
    imageHeight: 4485,
  },
  {
    slug: "the-night-watch",
    title: "The Night Watch",
    artistSlug: "rembrandt-van-rijn",
    year: "1642",
    medium: "Oil on canvas",
    dimensions: "363 × 437 cm",
    description:
      "Captain Frans Banninck Cocq's civic guard company bursts into motion — drums, muskets, a banner, a luminous girl with a chicken at her belt — where every other militia portrait of the age stood politely still.",
    story:
      "Rembrandt turned a routine group commission into theatre, sacrificing tidy rows of faces for light and drama. The canvas was trimmed on all four sides in 1715 to fit a wall in Amsterdam's town hall; the missing strips are known only from an old copy.",
    funFacts: [
      "It is actually a daytime scene — centuries of darkened varnish earned it the nickname 'Night Watch'.",
      "In 2021 the Rijksmuseum used AI trained on an old copy to digitally restore the trimmed edges.",
      "It has survived three separate attacks, including a knife slashing in 1975.",
    ],
    file: "The_Night_Watch_-_HD.jpg",
    imageWidth: 57813,
    imageHeight: 48438,
  },
  {
    slug: "rembrandt-self-portrait-1659",
    title: "Self-Portrait",
    artistSlug: "rembrandt-van-rijn",
    year: "1659",
    medium: "Oil on canvas",
    dimensions: "84.5 × 66 cm",
    description:
      "Rembrandt at fifty-three, painted the year after his house and goods were auctioned off — the face lined and guarded, the eyes lit with unsentimental clarity.",
    story:
      "He painted himself roughly eighty times across four decades, an autobiography in paint with no parallel in art history. Here, after bankruptcy, there is no costume and no bravado; only scrutiny.",
    funFacts: [
      "The pose deliberately echoes Raphael's portrait of Castiglione, which Rembrandt had seen at auction.",
      "It now hangs in the National Gallery of Art in Washington, D.C.",
    ],
    file: "Rembrandt_van_Rijn_-_Self-Portrait_-_Google_Art_Project.jpg",
    imageWidth: 12243,
    imageHeight: 15859,
  },
  {
    slug: "hunters-in-the-snow",
    title: "Hunters in the Snow",
    artistSlug: "pieter-bruegel-the-elder",
    year: "1565",
    medium: "Oil on panel",
    dimensions: "117 × 162 cm",
    description:
      "Three weary hunters and their dogs crest a hill above a white valley, where the whole village is out on the frozen ponds — skating, curling, carrying firewood under a green-grey winter sky.",
    story:
      "Part of a cycle of the seasons painted for an Antwerp merchant's house, it fixed the image of the European winter so firmly that it still shapes how we picture one — painted during one of the bitterest winters of the Little Ice Age.",
    funFacts: [
      "Five paintings of the six-part seasons cycle survive; this one represents December–January.",
      "It appears in films from Tarkovsky's 'Solaris' to 'Melancholia' as shorthand for winter itself.",
    ],
    file: "Pieter_Bruegel_the_Elder_-_Hunters_in_the_Snow_(Winter)_-_Google_Art_Project.jpg",
    imageWidth: 6819,
    imageHeight: 4853,
  },
  {
    slug: "the-birth-of-venus",
    title: "The Birth of Venus",
    artistSlug: "sandro-botticelli",
    year: "c. 1485",
    medium: "Tempera on canvas",
    dimensions: "172.5 × 278.9 cm",
    description:
      "Venus drifts ashore on a scallop shell, blown by entwined wind gods while an attendant rushes to wrap her in a flowered cloak — myth painted with the lightness of a dance.",
    story:
      "Almost certainly painted for the Medici, it was among the first monumental canvases of a classical nude in Tuscany since antiquity — a pagan goddess given the scale once reserved for altarpieces.",
    funFacts: [
      "Venus's improbably long neck and sloping shoulders are anatomically 'wrong' and visually perfect.",
      "Her hair is highlighted with real gold.",
      "Legend links her face to Simonetta Vespucci, the celebrated beauty of Florence.",
    ],
    file: "Sandro_Botticelli_-_La_nascita_di_Venere_-_Google_Art_Project_-_edited.jpg",
    imageWidth: 30000,
    imageHeight: 18840,
  },
  {
    slug: "mona-lisa",
    title: "Mona Lisa",
    artistSlug: "leonardo-da-vinci",
    year: "c. 1503–1506",
    medium: "Oil on poplar panel",
    dimensions: "77 × 53 cm",
    description:
      "Lisa Gherardini, wife of a Florentine silk merchant, regards the viewer with the most analysed half-smile in history, before a dreamlike landscape of winding rivers and hazy peaks.",
    story:
      "Leonardo kept the panel with him for years, refining it in layer after translucent layer of sfumato, and it was famous among artists long before the public knew it. Its 1911 theft by museum worker Vincenzo Peruggia — who kept it in a trunk for two years — turned fame into global celebrity.",
    funFacts: [
      "When it was stolen, crowds queued at the Louvre to stare at the empty wall.",
      "She has no clearly visible eyebrows — possibly lost to early cleaning.",
      "The painting has its own climate-controlled case and, at the Louvre, its own mailbox for fan letters.",
    ],
    file: "Mona_Lisa,_by_Leonardo_da_Vinci,_from_C2RMF_retouched.jpg",
    imageWidth: 7479,
    imageHeight: 11146,
  },
  {
    slug: "wanderer-above-the-sea-of-fog",
    title: "Wanderer above the Sea of Fog",
    artistSlug: "caspar-david-friedrich",
    year: "c. 1818",
    medium: "Oil on canvas",
    dimensions: "94.8 × 74.8 cm",
    description:
      "A man in a dark coat stands on a rocky summit with his back to us, looking out over an ocean of fog from which distant ridges rise like islands.",
    story:
      "Friedrich assembled the view from sketches of different rocks in the Elbe Sandstone Mountains — the landscape never existed as painted. The 'Rückenfigur', the figure seen from behind, invites us to take his place and confront the immensity ourselves.",
    funFacts: [
      "The wanderer's identity is unknown; suggestions range from a Saxon officer fallen in the Napoleonic wars to Friedrich himself.",
      "It has become the default cover image for Romanticism — and for half the philosophy books ever printed.",
    ],
    file: "Caspar_David_Friedrich_-_Wanderer_above_the_sea_of_fog.jpg",
    imageWidth: 2327,
    imageHeight: 2980,
  },
  {
    slug: "the-great-wave",
    title: "The Great Wave off Kanagawa",
    artistSlug: "katsushika-hokusai",
    year: "c. 1831",
    medium: "Woodblock print, ink and colour on paper",
    dimensions: "25.7 × 37.9 cm",
    description:
      "A monstrous claw of a wave rears over three open boats, its foam breaking into talons — while far behind, tiny and serene, sits the snow-capped cone of Mount Fuji.",
    story:
      "The opening print of Hokusai's 'Thirty-six Views of Mount Fuji', made when the artist was about seventy. Its deep blue came from imported Prussian blue pigment, a novelty that helped make the series a sensation.",
    funFacts: [
      "Thousands of impressions were printed; surviving early ones now sell for millions.",
      "Debussy kept a copy in his study and published 'La Mer' with the wave on its cover.",
      "The wave is the subject, but the series is officially about the tiny Fuji beneath it.",
    ],
    file: "Tsunami_by_hokusai_19th_century.jpg",
    imageWidth: 3859,
    imageHeight: 2594,
  },
  {
    slug: "the-kiss",
    title: "The Kiss",
    artistSlug: "gustav-klimt",
    year: "1907–1908",
    medium: "Oil and gold leaf on canvas",
    dimensions: "180 × 180 cm",
    description:
      "Two lovers kneel on a flowered cliff edge, wrapped into a single golden form — his robe patterned with stern rectangles, hers with soft circles — at the height of Klimt's Golden Period.",
    story:
      "Klimt, son of a gold engraver, layered real gold and silver leaf into the canvas. The Austrian state bought the painting in 1908 before he had even finished it — an instant acknowledgment that it was a national treasure.",
    funFacts: [
      "It is painted on a perfectly square canvas, 180 by 180 centimetres.",
      "It has never left Vienna and, by general agreement, never will.",
    ],
    file: "The_Kiss_-_Gustav_Klimt_-_Google_Cultural_Institute.jpg",
    imageWidth: 7376,
    imageHeight: 7401,
  },
];

type RoomSeed = {
  slug: string;
  name: string;
  description: string;
  layout: { width: number; depth: number; height: number } | null;
  artworks: { slug: string; wall?: PlacementWall; scale?: number }[];
};

type ExhibitionTheme = {
  wallColor?: string;
  accentWallColor?: string;
  floorColor?: string;
  ambientIntensity?: number;
  lightTemperature?: "warm" | "neutral" | "cool";
};

type MuseumSeed = {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  coverArtworkSlug: string;
  theme: ExhibitionTheme;
  rooms: RoomSeed[];
};

const museums: MuseumSeed[] = [
  {
    slug: "maison-lumiere",
    name: "Maison Lumière",
    tagline: "Impressionism and the painters of modern light",
    description:
      "A museum devoted to the revolution that began with a sunrise over Le Havre: the Impressionists' pursuit of fleeting light, and the Post-Impressionists who set that light on fire.",
    coverArtworkSlug: "the-starry-night",
    theme: {
      wallColor: "#a99d8a",
      accentWallColor: "#7e6e57",
      floorColor: "#4a3c2e",
      lightTemperature: "warm",
    },
    rooms: [
      {
        slug: "salon-of-light",
        name: "Salon of Light",
        description: "Sunlight, leisure and the new Paris — the heart of the Impressionist decade.",
        layout: { width: 24, depth: 15, height: 5.5 },
        artworks: [
          { slug: "impression-sunrise", wall: "north" },
          { slug: "woman-with-a-parasol", wall: "north" },
          { slug: "dance-at-le-moulin-de-la-galette", wall: "east" },
          { slug: "luncheon-of-the-boating-party", wall: "east" },
          { slug: "paris-street-rainy-day", wall: "west" },
          { slug: "a-sunday-on-la-grande-jatte", wall: "south" },
        ],
      },
      {
        slug: "the-night-gallery",
        name: "The Night Gallery",
        description:
          "Van Gogh's burning skies and the long shadow they cast — rooms get darker, colours get louder.",
        layout: null,
        artworks: [
          { slug: "the-starry-night" },
          { slug: "cafe-terrace-at-night" },
          { slug: "irises" },
          { slug: "almond-blossom" },
          { slug: "wheatfield-with-crows" },
          { slug: "the-scream" },
        ],
      },
    ],
  },
  {
    slug: "the-golden-hall",
    name: "The Golden Hall",
    tagline: "Old masters from Delft to Vienna",
    description:
      "Five centuries of mastery under one roof: Dutch light, Renaissance myth, Romantic fog, the perfect wave, and a room that ends in gold.",
    coverArtworkSlug: "girl-with-a-pearl-earring",
    theme: {
      wallColor: "#5d6660",
      accentWallColor: "#3f4a45",
      floorColor: "#2e2a26",
      lightTemperature: "neutral",
    },
    rooms: [
      {
        slug: "the-dutch-cabinet",
        name: "The Dutch Cabinet",
        description: "Quiet rooms and civic theatre — the Dutch Golden Age in five paintings.",
        layout: { width: 22, depth: 14, height: 6.5 },
        artworks: [
          { slug: "the-night-watch", wall: "north" },
          { slug: "girl-with-a-pearl-earring", wall: "east" },
          { slug: "the-milkmaid", wall: "east" },
          { slug: "rembrandt-self-portrait-1659", wall: "west" },
          { slug: "hunters-in-the-snow", wall: "south" },
        ],
      },
      {
        slug: "wonders-and-horizons",
        name: "Wonders & Horizons",
        description: "From Botticelli's shoreline to Klimt's gold — five images that became icons.",
        layout: null,
        artworks: [
          { slug: "the-birth-of-venus" },
          { slug: "mona-lisa" },
          { slug: "wanderer-above-the-sea-of-fog" },
          { slug: "the-great-wave", scale: 2.5 },
          { slug: "the-kiss" },
        ],
      },
    ],
  },
];

/** A single-room exhibition: a themed hang of works drawn from the museums. */
type GroupSeed = {
  slug: string;
  kind: Exclude<ExhibitionKind, "personal">;
  name: string;
  tagline: string;
  description: string;
  coverArtworkSlug: string;
  artistSlug?: string;
  theme?: ExhibitionTheme;
  artworks: string[];
};

const groups: GroupSeed[] = [
  {
    slug: "van-gogh-a-life-in-colour",
    kind: "artist_collection",
    name: "Van Gogh: A Life in Colour",
    tagline: "Five paintings, two years, one burning decade",
    description:
      "From the irises of his first asylum week to the wheatfield of his last summer — a short walk through the most intense two years in the history of painting.",
    coverArtworkSlug: "almond-blossom",
    artistSlug: "vincent-van-gogh",
    theme: {
      wallColor: "#3b4660",
      accentWallColor: "#2a3247",
      floorColor: "#26211c",
      lightTemperature: "cool",
    },
    artworks: [
      "irises",
      "the-starry-night",
      "cafe-terrace-at-night",
      "almond-blossom",
      "wheatfield-with-crows",
    ],
  },
  {
    slug: "nocturnes",
    kind: "exhibition",
    name: "Nocturnes: Painting the Night",
    tagline: "What artists see when the lights go out",
    description:
      "Four centuries of darkness — gaslight, starlight, a blood-red sunset and a 'night' that turned out to be day. An exhibition that crosses both museums.",
    coverArtworkSlug: "cafe-terrace-at-night",
    theme: {
      wallColor: "#2f3038",
      accentWallColor: "#23242b",
      floorColor: "#1c1a18",
      lightTemperature: "cool",
    },
    artworks: ["the-starry-night", "cafe-terrace-at-night", "the-scream", "the-night-watch"],
  },
  {
    slug: "faces-and-gazes",
    kind: "exhibition",
    name: "Faces & Gazes",
    tagline: "Five portraits that look back",
    description:
      "A girl who just turned around, a smile no one can read, a bankrupt master, a mother in the wind, and two lovers who never show their faces at all.",
    coverArtworkSlug: "mona-lisa",
    artworks: [
      "girl-with-a-pearl-earring",
      "mona-lisa",
      "rembrandt-self-portrait-1659",
      "woman-with-a-parasol",
      "the-kiss",
    ],
  },
];

const artistId = (slug: string) => `artist-${slug}`;
const artworkId = (slug: string) => `art-${slug}`;
const museumId = (slug: string) => `museum-${slug}`;
const groupId = (slug: string) => `group-${slug}`;
const roomId = (exhibitionId: string, slug: string) => `room-${exhibitionId}-${slug}`;

async function seed() {
  console.log("Seeding exhibition content…");

  // A synthetic owner id stamped on every seeded artwork (artwork.userId is
  // required). It is not a real Clerk user — these public works simply need a
  // stable owner that no human account will ever collide with.

  // Wipe previously seeded rows (cascades rooms and placements).
  await db
    .delete(exhibition)
    .where(
      inArray(exhibition.id, [
        ...museums.map((m) => museumId(m.slug)),
        ...groups.map((g) => groupId(g.slug)),
      ]),
    );
  await db.delete(artwork).where(
    inArray(
      artwork.id,
      artworks.map((a) => artworkId(a.slug)),
    ),
  );
  await db.delete(artist).where(
    inArray(
      artist.id,
      artists.map((a) => artistId(a.slug)),
    ),
  );

  await db.insert(artist).values(
    artists.map((a) => ({
      id: artistId(a.slug),
      slug: a.slug,
      name: a.name,
      bio: a.bio,
      birthYear: a.birthYear,
      deathYear: a.deathYear,
      nationality: a.nationality,
    })),
  );
  console.log(`  ${artists.length} artists`);

  const artworkBySlug = new Map(artworks.map((a) => [a.slug, a]));
  const coverUrl = (slug: string) => {
    const a = artworkBySlug.get(slug);
    if (!a) throw new Error(`Unknown cover artwork slug: ${slug}`);
    return commonsUrl(a.file, 1280);
  };

  await db.insert(artwork).values(
    artworks.map((a) => {
      const seedArtist = artists.find((x) => x.slug === a.artistSlug);
      if (!seedArtist) throw new Error(`Unknown artist slug: ${a.artistSlug}`);
      return {
        id: artworkId(a.slug),
        userId: CURATOR_ID,
        title: a.title,
        artist: seedArtist.name,
        artistId: artistId(a.artistSlug),
        artworkType: "painting",
        year: a.year,
        medium: a.medium,
        dimensions: a.dimensions,
        description: a.description,
        story: a.story,
        funFacts: a.funFacts,
        imageUrl: commonsUrl(a.file, 1920),
        thumbnailUrl: commonsUrl(a.file, 480),
        imageWidth: a.imageWidth,
        imageHeight: a.imageHeight,
        isPublished: true,
      };
    }),
  );
  console.log(`  ${artworks.length} artworks`);

  const insertRooms = async (exhibitionId: string, rooms: RoomSeed[]) => {
    for (const [rIndex, r] of rooms.entries()) {
      await db.insert(room).values({
        id: roomId(exhibitionId, r.slug),
        exhibitionId,
        slug: r.slug,
        name: r.name,
        description: r.description,
        layout: r.layout,
        sortOrder: rIndex,
      });

      await db.insert(placement).values(
        r.artworks.map((p, pIndex) => {
          if (!artworkBySlug.has(p.slug)) throw new Error(`Unknown artwork slug: ${p.slug}`);
          return {
            roomId: roomId(exhibitionId, r.slug),
            artworkId: artworkId(p.slug),
            position: pIndex,
            wall: p.wall ?? null,
            scale: p.scale ?? null,
          };
        }),
      );
    }
  };

  for (const [mIndex, m] of museums.entries()) {
    await db.insert(exhibition).values({
      id: museumId(m.slug),
      slug: m.slug,
      kind: "exhibition",
      name: m.name,
      tagline: m.tagline,
      description: m.description,
      coverImageUrl: coverUrl(m.coverArtworkSlug),
      theme: m.theme,
      isPublished: true,
      sortOrder: mIndex,
    });
    await insertRooms(museumId(m.slug), m.rooms);
  }
  console.log(`  ${museums.length} multi-room exhibitions`);

  for (const [gIndex, g] of groups.entries()) {
    await db.insert(exhibition).values({
      id: groupId(g.slug),
      slug: g.slug,
      kind: g.kind,
      name: g.name,
      tagline: g.tagline,
      description: g.description,
      coverImageUrl: coverUrl(g.coverArtworkSlug),
      artistId: g.artistSlug ? artistId(g.artistSlug) : null,
      theme: g.theme ?? null,
      isPublished: true,
      sortOrder: museums.length + gIndex,
    });
    await insertRooms(groupId(g.slug), [
      {
        slug: "main",
        name: g.name,
        description: g.description,
        layout: null,
        artworks: g.artworks.map((slug) => ({ slug })),
      },
    ]);
  }
  console.log(`  ${groups.length} single-room exhibitions`);
  console.log("Done.");
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
