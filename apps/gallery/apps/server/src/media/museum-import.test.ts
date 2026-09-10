import { afterEach, describe, expect, test } from "bun:test";

import {
	fetchMuseumObject,
	guessArtworkType,
	parseMuseumUrl,
} from "./museum-import";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** True when the thunk rejects — avoids the bun-types `await`-no-effect hint
 * on `expect(...).rejects`. */
async function rejected(fn: () => Promise<unknown>): Promise<boolean> {
	try {
		await fn();
		return false;
	} catch {
		return true;
	}
}

/** Stub global fetch with a URL→JSON router; every response is `ok`. */
function stubFetch(route: (url: string) => unknown) {
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		return {
			ok: true,
			status: 200,
			json: async () => route(url),
		} as Response;
	}) as typeof fetch;
}

describe("guessArtworkType", () => {
	test("maps mediums to a type, defaulting to other", () => {
		expect(guessArtworkType("Oil on canvas")).toBe("painting");
		expect(guessArtworkType("Gelatin silver print")).toBe("photo");
		expect(guessArtworkType("Bronze")).toBe("sculpture");
		expect(guessArtworkType("Etching and aquatint")).toBe("print");
		expect(guessArtworkType("Performance")).toBe("other");
		expect(guessArtworkType(null)).toBe("other");
	});
});

describe("parseMuseumUrl", () => {
	test("extracts source + id from known hosts", () => {
		expect(
			parseMuseumUrl("https://www.metmuseum.org/art/collection/search/436524"),
		).toEqual({ source: "met", objectId: "436524" });
		expect(
			parseMuseumUrl("https://www.artic.edu/artworks/27992/the-bedroom"),
		).toEqual({ source: "artic", objectId: "27992" });
		expect(parseMuseumUrl("https://www.wikidata.org/wiki/Q45585")).toEqual({
			source: "wikidata",
			objectId: "Q45585",
		});
	});

	test("returns null for an unrecognized host", () => {
		expect(parseMuseumUrl("https://example.com/art/1")).toBeNull();
		expect(parseMuseumUrl("not a url")).toBeNull();
	});
});

describe("fetchMuseumObject — Met", () => {
	test("normalizes the Met payload and parses its dimensions", async () => {
		stubFetch(() => ({
			title: "Wheat Field with Cypresses",
			artistDisplayName: "Vincent van Gogh",
			artistNationality: "Dutch",
			artistBeginDate: "1853",
			artistEndDate: "1890",
			objectDate: "1889",
			medium: "Oil on canvas",
			dimensions: "28 7/8 x 36 3/4 in. (73.2 x 93.4 cm)",
			primaryImage: "https://images.metmuseum.org/big.jpg",
			objectURL: "https://www.metmuseum.org/art/collection/search/436535",
			creditLine: "Purchase, 1993",
		}));
		const obj = await fetchMuseumObject("met", "436535");
		expect(obj.title).toBe("Wheat Field with Cypresses");
		expect(obj.dimensions).toBe("28 7/8 x 36 3/4 in. (73.2 x 93.4 cm)");
		expect(obj.imageUrl).toBe("https://images.metmuseum.org/big.jpg");
		expect(obj.credit).toBe("Purchase, 1993");
		expect(obj.artist).toEqual({
			name: "Vincent van Gogh",
			nationality: "Dutch",
			birthYear: 1853,
			deathYear: 1890,
		});
	});

	test("rejects a non-numeric Met id", async () => {
		expect(await rejected(() => fetchMuseumObject("met", "abc"))).toBe(true);
	});
});

describe("fetchMuseumObject — Art Institute", () => {
	test("builds the IIIF image URL and strips the HTML description", async () => {
		stubFetch(() => ({
			data: {
				title: "The Bedroom",
				artist_title: "Vincent van Gogh",
				artist_display: "Vincent van Gogh\nDutch, 1853–1890",
				date_display: "1889",
				medium_display: "Oil on canvas",
				dimensions: "73.6 × 92.3 cm (29 × 36 5/16 in.)",
				image_id: "image-xyz",
				description: "<p>A <b>famous</b> bedroom.</p>",
				credit_line: "Helen Birch Bartlett",
			},
			config: { iiif_url: "https://www.artic.edu/iiif/2" },
		}));
		const obj = await fetchMuseumObject("artic", "28560");
		expect(obj.imageUrl).toBe(
			"https://www.artic.edu/iiif/2/image-xyz/full/1686,/0/default.jpg",
		);
		expect(obj.description).toBe("A famous bedroom.");
		expect(obj.dimensions).toBe("73.6 × 92.3 cm (29 × 36 5/16 in.)");
		expect(obj.artist?.nationality).toBe("Dutch");
		expect(obj.artist?.birthYear).toBe(1853);
		expect(obj.artist?.deathYear).toBe(1890);
	});
});

describe("fetchMuseumObject — Wikidata", () => {
	test("assembles dimensions, medium and artist from claims + label lookups", async () => {
		stubFetch((url) => {
			if (url.includes("Special:EntityData")) {
				return {
					entities: {
						Q12345: {
							labels: { en: { value: "Test Painting" } },
							descriptions: { en: { value: "a test work" } },
							claims: {
								P571: [
									{
										mainsnak: {
											datavalue: { value: { time: "+1889-00-00T00:00:00Z" } },
										},
									},
								],
								P2048: [
									{
										mainsnak: {
											datavalue: {
												value: {
													amount: "+73.7",
													unit: "http://www.wikidata.org/entity/Q174728",
												},
											},
										},
									},
								],
								P2049: [
									{
										mainsnak: {
											datavalue: {
												value: {
													amount: "+92.1",
													unit: "http://www.wikidata.org/entity/Q174728",
												},
											},
										},
									},
								],
								P18: [
									{ mainsnak: { datavalue: { value: "Test Painting.jpg" } } },
								],
								P170: [{ mainsnak: { datavalue: { value: { id: "Q762" } } } }],
								P186: [
									{ mainsnak: { datavalue: { value: { id: "Q296955" } } } },
								],
							},
						},
					},
				};
			}
			if (url.includes("ids=Q762") || url.includes("Q296955")) {
				return {
					entities: {
						Q762: {
							labels: { en: { value: "Leonardo da Vinci" } },
							claims: {
								P569: [
									{
										mainsnak: {
											datavalue: { value: { time: "+1452-00-00T00:00:00Z" } },
										},
									},
								],
								P570: [
									{
										mainsnak: {
											datavalue: { value: { time: "+1519-00-00T00:00:00Z" } },
										},
									},
								],
								P27: [{ mainsnak: { datavalue: { value: { id: "Q38" } } } }],
							},
						},
						Q296955: { labels: { en: { value: "oil paint" } }, claims: {} },
					},
				};
			}
			// Country label lookup.
			return {
				entities: { Q38: { labels: { en: { value: "Italy" } }, claims: {} } },
			};
		});

		const obj = await fetchMuseumObject("wikidata", "q12345");
		expect(obj.title).toBe("Test Painting");
		expect(obj.year).toBe("1889");
		expect(obj.dimensions).toBe("73.7 × 92.1 cm");
		expect(obj.medium).toBe("oil paint");
		expect(obj.imageUrl).toContain(
			"Special:FilePath/Test%20Painting.jpg?width=1600",
		);
		expect(obj.artist).toEqual({
			name: "Leonardo da Vinci",
			nationality: "Italy",
			birthYear: 1452,
			deathYear: 1519,
		});
	});

	test("rejects a malformed Q-id", async () => {
		expect(await rejected(() => fetchMuseumObject("wikidata", "12345"))).toBe(
			true,
		);
	});
});
