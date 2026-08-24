// Extract WhatsApp messages from the Mac app's ChatStorage.sqlite into
// bank-import-json NDJSON. Reads a *copy* of the DB (WAL-safe), never the live file.
//
// Usage: bun wa-extract.ts <chatstorage-copy.sqlite> > whatsapp.ndjson
import { Database } from "bun:sqlite";

const APPLE_EPOCH = 978307200; // Core Data timestamps are seconds since 2001-01-01

const db = new Database(process.argv[2], { readonly: true });

// JID -> display name (contact push names; group members resolve through this too)
const pushnames = new Map<string, string>(
    db.query<{ ZJID: string; ZPUSHNAME: string }, []>(
        "select ZJID, ZPUSHNAME from ZWAPROFILEPUSHNAME where ZPUSHNAME is not null"
    ).all().map(r => [r.ZJID, r.ZPUSHNAME])
);

const rows = db.query<{
    stanza: string | null;
    text: string | null;
    ts: number;
    fromme: number;
    chat_jid: string;
    chat_name: string | null;
    session_type: number;
    member_jid: string | null;
    msg_type: number;
}, []>(`
    select m.ZSTANZAID stanza, m.ZTEXT text, m.ZMESSAGEDATE ts, m.ZISFROMME fromme,
           cs.ZCONTACTJID chat_jid, cs.ZPARTNERNAME chat_name, cs.ZSESSIONTYPE session_type,
           gm.ZMEMBERJID member_jid, m.ZMESSAGETYPE msg_type
    from ZWAMESSAGE m
    join ZWACHATSESSION cs on m.ZCHATSESSION = cs.Z_PK
    left join ZWAGROUPMEMBER gm on m.ZGROUPMEMBER = gm.Z_PK
    order by m.ZMESSAGEDATE
`).all();

let out = 0, skipped = 0;
for (const r of rows) {
    if (!r.text) { skipped++; continue; } // media/system messages carry no text here
    const sender = r.fromme
        ? "Thomas Breindl"
        : r.session_type === 1
            ? (r.member_jid && pushnames.get(r.member_jid)) || r.member_jid || r.chat_name || r.chat_jid
            : r.chat_name || pushnames.get(r.chat_jid) || r.chat_jid;
    const entry = {
        body: r.text,
        thread: r.chat_name || r.chat_jid,
        sender,
        sent_at: new Date((r.ts + APPLE_EPOCH) * 1000).toISOString(),
        external_id: r.stanza ?? undefined,
    };
    console.log(JSON.stringify(entry));
    out++;
}
console.error(`${out} messages written, ${skipped} without text skipped (media/system)`);
