// Extract WhatsApp messages from the Mac app's ChatStorage.sqlite into
// bank-import-json NDJSON. Reads a *copy* of the DB (WAL-safe), never the live file.
//
// Usage: bun wa-extract.ts <chatstorage-copy.sqlite> > whatsapp.ndjson
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const APPLE_EPOCH = 978307200; // Core Data timestamps are seconds since 2001-01-01

// ZMESSAGETYPE values whose messages are media without a ZTEXT body. They get
// a typed placeholder (plus the caption from ZWAMEDIAITEM.ZTITLE) so the
// conversation keeps its shape; system events and unknown types stay skipped.
const MEDIA_KIND: Record<number, string> = {
  1: "photo",
  2: "video",
  3: "voice message",
  4: "contact card",
  5: "location",
  8: "document",
  11: "GIF",
  15: "sticker",
};

const db = new Database(process.argv[2], { readonly: true });

// JID -> display name (contact push names; group members resolve through this too)
const pushnames = new Map<string, string>(
  db
    .query<{ ZJID: string; ZPUSHNAME: string }, []>(
      "select ZJID, ZPUSHNAME from ZWAPROFILEPUSHNAME where ZPUSHNAME is not null",
    )
    .all()
    .map((r) => [r.ZJID, r.ZPUSHNAME]),
);

// Group members the pushname table misses are still in the Mac app's address
// book, keyed by the same lid the message carries. That file sits next to
// ChatStorage.sqlite; without it (or on an older schema without ZLID) those
// senders stay raw jids, which is what they were before.
function lidNames(chatPath: string): Map<string, string> {
  const out = new Map<string, string>();
  const path = join(dirname(chatPath), "ContactsV2.sqlite");
  if (!existsSync(path)) return out;
  try {
    const rows = new Database(path, { readonly: true })
      .query<{ ZLID: string; ZFULLNAME: string }, []>(
        "select ZLID, ZFULLNAME from ZWAADDRESSBOOKCONTACT where ZLID is not null and ZFULLNAME is not null",
      )
      .all();
    for (const r of rows) {
      out.set(r.ZLID, r.ZFULLNAME);
      out.set(r.ZLID.split("@")[0]!, r.ZFULLNAME); // messages may carry the bare number
    }
  } catch (err) {
    console.error(`ContactsV2.sqlite unreadable (${err}); group senders stay raw jids`);
  }
  return out;
}

const addressBook = lidNames(process.argv[2]);

const rows = db
  .query<
    {
      stanza: string | null;
      text: string | null;
      ts: number;
      fromme: number;
      chat_jid: string;
      chat_name: string | null;
      session_type: number;
      member_jid: string | null;
      msg_type: number;
      media_title: string | null;
      vcard_name: string | null;
    },
    []
  >(`
    select m.ZSTANZAID stanza, m.ZTEXT text, m.ZMESSAGEDATE ts, m.ZISFROMME fromme,
           cs.ZCONTACTJID chat_jid, cs.ZPARTNERNAME chat_name, cs.ZSESSIONTYPE session_type,
           gm.ZMEMBERJID member_jid, m.ZMESSAGETYPE msg_type,
           mi.ZTITLE media_title, mi.ZVCARDNAME vcard_name
    from ZWAMESSAGE m
    join ZWACHATSESSION cs on m.ZCHATSESSION = cs.Z_PK
    left join ZWAGROUPMEMBER gm on m.ZGROUPMEMBER = gm.Z_PK
    left join ZWAMEDIAITEM mi on m.ZMEDIAITEM = mi.Z_PK
    order by m.ZMESSAGEDATE
`)
  .all();

// A group member's display name: their pushname, else the address book, else
// nothing and the caller keeps the raw jid.
function memberName(jid: string) {
  return pushnames.get(jid) || addressBook.get(jid) || addressBook.get(jid.split("@")[0]!);
}

function mediaBody(r: { msg_type: number; media_title: string | null; vcard_name: string | null }) {
  const kind = MEDIA_KIND[r.msg_type];
  if (!kind) return null;
  const label = r.msg_type === 4 && r.vcard_name ? `${kind}: ${r.vcard_name}` : kind;
  return r.media_title ? `[${label}] ${r.media_title}` : `[${label}]`;
}

let out = 0,
  media = 0,
  skipped = 0;
for (const r of rows) {
  let body = r.text;
  if (!body) {
    body = mediaBody(r);
    if (!body) {
      skipped++;
      continue;
    } // system events, deleted, unknown types
    media++;
  }
  const sender = r.fromme
    ? "Thomas Breindl"
    : r.session_type === 1
      ? (r.member_jid && memberName(r.member_jid)) || r.member_jid || r.chat_name || r.chat_jid
      : r.chat_name || pushnames.get(r.chat_jid) || r.chat_jid;
  const entry = {
    body,
    thread: r.chat_name || r.chat_jid,
    // group chats carry the group name as subject so viewers can title
    // the thread even where thread ids are raw JIDs
    subject: r.session_type === 1 ? (r.chat_name ?? undefined) : undefined,
    sender,
    sent_at: new Date((r.ts + APPLE_EPOCH) * 1000).toISOString(),
    external_id: r.stanza ?? undefined,
  };
  console.log(JSON.stringify(entry));
  out++;
}
console.error(
  `${out} messages written (${media} media placeholders), ${skipped} skipped (system/unknown)`,
);
