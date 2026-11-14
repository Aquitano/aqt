import { Button } from "@aqt/ui/components/button";
import { Card, CardContent } from "@aqt/ui/components/card";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useId, useState } from "react";

import type { Message } from "@/lib/api";

function groupingReason(mail: NonNullable<Message["mail"]>) {
  if (mail.native) return "The provider filed this message under its thread.";
  if (mail.in_reply_to.length || mail.references.length)
    return "Reply headers connect this message to its conversation. Other mail's headers can connect it too.";
  return "No reply headers or provider thread were recorded. Replies to it can still join it.";
}

export function MessageProvenance({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const mail = message.mail;
  const fields = [
    ["Source", message.source],
    ["Message ref", message.ref || "Not recorded"],
    ["External ID", message.external_id || "Not recorded"],
    [
      "Raw input",
      message.raw_input
        ? `#${message.raw_input}${message.raw_locator ? `, at ${message.raw_locator}` : ""}`
        : "Not recorded",
    ],
    ["Current conversation", message.thread_id || "None"],
    ...(mail
      ? [
          ["Normalized Message-ID", mail.message_id || "None usable"],
          ["In-Reply-To", mail.in_reply_to.join(", ") || "None"],
          ["References", mail.references.join(", ") || "None"],
          ["Thread from provider", mail.native ? "Yes" : "No"],
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
              {mail && <p>{groupingReason(mail)}</p>}
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
