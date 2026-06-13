export type ArtworkCard = {
	id: string;
	title: string;
	artist: string | null;
	artworkType: string;
	rating: number | null;
	assetId: string | null;
	width: number | null;
	height: number | null;
	thumbnailUrl: string | null;
	originalUrl: string | null;
	tags: { id: string; name: string; slug: string }[];
};

export type ActiveGalleryTab = "archive" | "galleries" | "reviews" | "connect";
