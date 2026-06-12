export const artworkTypes = [
	"painting",
	"photo",
	"sculpture",
	"print",
	"object",
	"other",
] as const;
export const sortModes = ["manual", "newest", "oldest", "title"] as const;

export function slugify(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)+/g, "");
}

export function filenameTitle(filename: string) {
	return filename
		.replace(/\.[^/.]+$/, "")
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
