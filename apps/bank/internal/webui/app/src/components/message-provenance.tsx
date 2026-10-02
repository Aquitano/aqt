import { ChevronDown, ChevronUp } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { Message } from "@/lib/api";

function groupingReason(mail: NonNullable<Message["mail"]>) {
  if (mail.incomplete)
    return "Grouping reached a configured limit. The saved headers may not yet match the conversation. Raise the limit and rebuild to retry.";
  if (mail.conflict_key)
    return "Reply headers connect conflicting provider threads. Provider groups are preserved and unanchored messages stay separate.";
  if (mail.native_thread_id) return "This message has an explicit provider thread ID.";
  if (mail.has_reply_links)
    return "Reply headers connect this message to its conversation. The connection may come from another message.";
  return "No reply links or provider thread ID were recorded.";
}

export function MessageProvenance({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const mail = message.mail;
  const fields = [
    ["Source", message.source],
    ["Message ref", message.ref || "Not recorded"],
    ["External ID", message.external_id || "Not recorded"],
    ["Original archived input", message.raw_ref || "Not recorded"],
    ["Current conversation", message.thread_id || "None"],
    ...(mail
      ? [
          ["Header archived input", mail.raw_ref || "Not recorded for these headers"],
          ["Normalized Message-ID", mail.message_id || "None usable"],
          ["In-Reply-To", mail.in_reply_to.join(", ") || "None"],
          ["References", mail.references.join(", ") || "None"],
          ["Provider thread ID", mail.native_thread_id || "None recorded"],
          ["Conflict key", mail.conflict_key || "None"],
        ]
      : []),
  ];
  return (
    <div className="mt-3">
      <Button
        variant="ghost"
        size="sm"
        className="h-auto max-w-full whitespace-normal"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronUp data-icon="inline-start" /> : <ChevronDown data-icon="inline-start" />}
        Message provenance
      </Button>
      <div id={contentId} hidden={!open}>
        {open && (
          <Card className="mt-2 py-3 text-xs">
            <CardContent className="space-y-3 px-3">
              {mail && (
                <p
                  className={mail.incomplete || mail.conflict_key ? "text-destructive" : undefined}
                >
                  {groupingReason(mail)}
                </p>
              )}
              <dl className="grid gap-2">
                {fields.map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="wrap-anywhere whitespace-pre-wrap">{value}</dd>
                  </div>
                ))}
                <div>
                  <dt className="text-muted-foreground">Historically observed folders</dt>
                  <dd>
                    {message.mailboxes?.length ? (
                      <ul className="space-y-1">
                        {message.mailboxes.map((mailbox) => (
                          <li key={mailbox.id} className="wrap-anywhere">
                            {mailbox.path} ({mailbox.kind})
                          </li>
                        ))}
                      </ul>
                    ) : (
                      "None recorded"
                    )}
                  </dd>
                </div>
              </dl>
              <p className="text-muted-foreground">
                Archive paths are relative to the server archive. Folder observations do not track
                current moves or deletions.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
