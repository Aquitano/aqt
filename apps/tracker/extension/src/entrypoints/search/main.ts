import { search, type SearchHit } from "../../lib/api.ts";
import { element } from "../../lib/dom.ts";
import { describeVisits } from "../../lib/recall.ts";
import { loadSettings } from "../../lib/storage.ts";

const RESULTS = 20;

const status = element("status", HTMLParagraphElement);
const hits = element("hits", HTMLOListElement);

function paragraph(text: string, className?: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.textContent = text;
  if (className) p.className = className;
  return p;
}

function hitItem(hit: SearchHit, now: number): HTMLLIElement {
  const link = document.createElement("a");
  link.href = hit.canonical_url;
  link.textContent = hit.title || hit.canonical_url;
  const meta = [
    URL.parse(hit.canonical_url)?.hostname,
    hit.extractor,
    describeVisits("read", hit.visits, now),
  ].filter((part) => part !== undefined);
  const item = document.createElement("li");
  item.append(link, paragraph(meta.join(" · "), "meta"), paragraph(hit.snippet));
  return item;
}

async function show(query: string): Promise<void> {
  if (query === "") return;
  document.title = `${query} - aqt tracker search`;
  status.textContent = "searching";
  const result = await search((await loadSettings()).serverUrl, query, RESULTS);
  if (!result.ok) {
    status.textContent = result.error;
    return;
  }
  status.textContent = result.value.length === 0 ? "nothing found" : "";
  const now = Date.now();
  hits.replaceChildren(...result.value.map((hit) => hitItem(hit, now)));
}

const query = new URLSearchParams(location.search).get("q")?.trim() ?? "";
element("query", HTMLInputElement).value = query;
void show(query);
