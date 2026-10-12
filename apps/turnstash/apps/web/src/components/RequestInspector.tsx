import { providerLabels } from "@aqt/turnstash-api";
import type { RequestDetail, ValuationView } from "@aqt/turnstash-api";
import { Badge } from "@aqt/ui/components/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@aqt/ui/components/dialog";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { dateTime, int, json, preciseUsd } from "../format";
import { requestQuery } from "../queries";
import { Async } from "./Async";
import { Disclosure } from "./Disclosure";
import { codeBlock } from "./MessagePartView";

const kv = "grid grid-cols-[minmax(120px,auto)_1fr] gap-x-5 gap-y-1.5 text-[13px]";

const Row = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="wrap-anywhere">{children}</dd>
  </>
);

const Valuation = ({ valuation }: { readonly valuation: ValuationView }) => (
  <Disclosure
    defaultOpen={valuation.active}
    summary={
      <>
        {valuation.active && <Badge variant="success">active</Badge>}
        <span>{valuation.catalogVersion}</span>
        <span>
          {valuation.costUsd === null
            ? (valuation.unpricedReason ?? "unpriced")
            : preciseUsd(valuation.costUsd)}
        </span>
        <span>{dateTime(valuation.computedAt)}</span>
      </>
    }
  >
    <div className="flex flex-col gap-2">
      <dl className={kv}>
        <Row label="Price key">{valuation.priceKey ?? "—"}</Row>
      </dl>
      <pre className={codeBlock}>{json(valuation.breakdown)}</pre>
    </div>
  </Disclosure>
);

const Body = ({ detail }: { readonly detail: RequestDetail }) => {
  const { request } = detail;
  return (
    <div className="flex flex-col gap-6">
      <dl className={kv}>
        <Row label="Conversation">
          {detail.conversationTitle ?? detail.conversationKey} · {providerLabels[detail.provider]}
        </Row>
        <Row label="Requested">{dateTime(request.requestedAt)}</Row>
        <Row label="Model (raw)">{request.modelRaw}</Row>
        <Row label="Model (resolved)">{request.modelId}</Row>
        <Row label="Route">{request.route ?? "direct"}</Row>
        <Row label="Usage basis">
          <Badge variant="secondary">{request.usageBasis}</Badge>
        </Row>
        <Row label="Input">{int(request.inputTokens)}</Row>
        <Row label="Cache read">{int(request.cacheReadTokens)}</Row>
        <Row label="Cache write (5m)">{int(request.cacheWriteTokens)}</Row>
        <Row label="Cache write (1h)">{int(request.cacheWrite1hTokens)}</Row>
        <Row label="Output">{int(request.outputTokens)}</Row>
        <Row label="Reasoning">{int(request.reasoningTokens)}</Row>
        <Row label="Cost">
          {request.costUsd === null
            ? (request.unpricedReason ?? "unpriced")
            : preciseUsd(request.costUsd)}
        </Row>
        {detail.sourceRecord !== null && (
          <Row label="Source record">
            {detail.sourceRecord.streamId} #{detail.sourceRecord.recordKey}
          </Row>
        )}
      </dl>

      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted-foreground">Valuations</span>
        {detail.valuations.map((valuation) => (
          <Valuation
            key={`${valuation.catalogVersion}-${valuation.computedAt}`}
            valuation={valuation}
          />
        ))}
      </div>

      <Disclosure summary="Catalog price entry">
        <pre className={codeBlock}>{json(detail.priceEntry)}</pre>
      </Disclosure>
    </div>
  );
};

export const RequestInspector = ({
  requestId,
  onClose,
}: {
  readonly requestId: string | null;
  readonly onClose: () => void;
}) => {
  const detail = useQuery(requestQuery(requestId));

  return (
    <Dialog
      open={requestId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Request inspector</DialogTitle>
        </DialogHeader>
        {requestId !== null && <Async query={detail}>{(data) => <Body detail={data} />}</Async>}
      </DialogContent>
    </Dialog>
  );
};
