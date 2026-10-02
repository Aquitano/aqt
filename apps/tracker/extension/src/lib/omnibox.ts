import { browser, type Browser } from "wxt/browser";

import { search } from "./api.ts";
import { searchPagePath, suggestionDescription } from "./recall.ts";
import { loadSettings } from "./storage.ts";

const SUGGESTIONS = 6;
const TYPING_PAUSE_MS = 250;

type Suggest = (results: Browser.omnibox.SuggestResult[]) => void;

let typing: ReturnType<typeof setTimeout> | undefined;

export function onOmniboxInput(text: string, suggest: Suggest): void {
  clearTimeout(typing);
  const query = text.trim();
  if (query === "") return;
  typing = setTimeout(() => void suggestHits(query, suggest), TYPING_PAUSE_MS);
}

async function suggestHits(query: string, suggest: Suggest): Promise<void> {
  const result = await search((await loadSettings()).serverUrl, query, SUGGESTIONS);
  if (!result.ok) return;
  suggest(
    result.value.map((hit) => ({
      content: hit.canonical_url,
      description: suggestionDescription(hit),
    })),
  );
}

// A suggestion's content is its URL; anything else is what was typed.
export async function onOmniboxEnter(
  text: string,
  disposition: `${Browser.omnibox.OnInputEnteredDisposition}`,
): Promise<void> {
  const typed = URL.parse(text);
  const url =
    typed?.protocol === "http:" || typed?.protocol === "https:"
      ? typed.href
      : searchPagePath(text.trim());
  if (disposition === "currentTab") await browser.tabs.update({ url });
  else await browser.tabs.create({ url, active: disposition === "newForegroundTab" });
}
