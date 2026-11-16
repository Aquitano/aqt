import { useCurrentFrame } from "remotion";

import { Day, Plate, Sources } from "./shots/Archive";
import { Field } from "./shots/Field";
import { Finale } from "./shots/Finale";
import { Contact, Count, Derive, Resolve } from "./shots/Instruments";
import { Caret, Push, Query, RecordShot, Scan, type Clock } from "./shots/Record";
import type { Cut } from "./timeline";

export function ShotView({ cut }: { cut: Cut }) {
  const t = useCurrentFrame();
  const clock: Clock = { t, duration: cut.duration, now: cut.from + t };
  const shot = cut.shot;
  switch (shot.type) {
    case "caret":
      return <Caret clock={clock} />;
    case "record":
      return (
        <Push clock={clock}>
          <RecordShot entry={shot.entry} clock={clock} close={shot.close} />
        </Push>
      );
    case "scan":
      return (
        <Push clock={clock} by={0.05}>
          <Scan clock={clock} />
        </Push>
      );
    case "query":
      return <Query command={shot.command} query={shot.query} clock={clock} />;
    case "derive":
      return (
        <Push clock={clock}>
          <Derive entry={shot.entry} clock={clock} />
        </Push>
      );
    case "resolve":
      return (
        <Push clock={clock}>
          <Resolve clock={clock} />
        </Push>
      );
    case "count":
      return (
        <Push clock={clock}>
          <Count clock={clock} />
        </Push>
      );
    case "contact":
      return (
        <Push clock={clock}>
          <Contact clock={clock} />
        </Push>
      );
    case "day":
      return <Day clock={clock} />;
    case "sources":
      return <Sources clock={clock} />;
    case "field":
      return <Field span={shot.span} t={t} duration={cut.duration} />;
    case "plate":
      return <Plate clock={clock} />;
    case "answer":
      return <Finale clock={clock} />;
    default:
      return shot satisfies never;
  }
}
