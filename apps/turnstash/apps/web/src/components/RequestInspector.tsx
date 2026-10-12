import { providerLabels } from "@aqt/turnstash-api";
import type { RequestDetail, ValuationView } from "@aqt/turnstash-api";
import { Badge, Button, Dialog } from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { dateTime, int, json, preciseUsd } from "../format";
import { requestQuery } from "../queries";
import { Async } from "./Async";
import { Disclosure } from "./Disclosure";

const Row = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <>
    <dt>{label}</dt>
    <dd>{children}</dd>
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
    <dl className="kv">
      <Row label="Price key">{valuation.priceKey ?? "—"}</Row>
    </dl>
    <pre className="part-code">{json(valuation.breakdown)}</pre>
  </Disclosure>
);

const Body = ({ detail }: { readonly detail: RequestDetail }) => {
  const { request } = detail;
  return (
    <div className="stack">
      <dl className="kv">
        <Row label="Conversation">
          {detail.conversationTitle ?? detail.conversationKey} · {providerLabels[detail.provider]}
        </Row>
        <Row label="Requested">{dateTime(request.requestedAt)}</Row>
        <Row label="Model (raw)">{request.modelRaw}</Row>
        <Row label="Model (resolved)">{request.modelId}</Row>
        <Row label="Route">{request.route ?? "direct"}</Row>
        <Row label="Usage basis">
          <Badge variant="neutral">{request.usageBasis}</Badge>
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

      <div className="stack">
        <span className="card-note">Valuations</span>
        {detail.valuations.map((valuation) => (
          <Valuation
            key={`${valuation.catalogVersion}-${valuation.computedAt}`}
            valuation={valuation}
          />
        ))}
      </div>

      <Disclosure summary="Catalog price entry">
        <pre className="part-code">{json(detail.priceEntry)}</pre>
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
    <Dialog.Root
      open={requestId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog size="xl" className="p-6">
        <div className="card-head">
          <Dialog.Title className="card-title">Request inspector</Dialog.Title>
          <Dialog.Close
            render={
              <Button
                size="sm"
                shape="square"
                variant="ghost"
                icon={<XIcon />}
                aria-label="Close"
              />
            }
          />
        </div>
        {requestId !== null && <Async query={detail}>{(data) => <Body detail={data} />}</Async>}
      </Dialog>
    </Dialog.Root>
  );
};
