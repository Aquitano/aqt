import { ChartAreaInteractive } from "./charts/area-interactive";
import { ChartAreaStacked } from "./charts/area-stacked";
import { ChartBarInteractive } from "./charts/bar-interactive";
import { ChartBarMultiple } from "./charts/bar-multiple";
import { ChartLineInteractive } from "./charts/line-interactive";
import { ChartPieDonutText } from "./charts/pie-donut-text";
import { ChartRadarDots } from "./charts/radar-dots";
import { ChartRadialStacked } from "./charts/radial-stacked";

export function Charts() {
  return (
    <div className="flex flex-col gap-4">
      <ChartAreaInteractive />
      <ChartBarInteractive />
      <div className="grid gap-4 md:grid-cols-3">
        <ChartPieDonutText />
        <ChartRadialStacked />
        <ChartRadarDots />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <ChartBarMultiple />
        <ChartAreaStacked />
      </div>
      <ChartLineInteractive />
    </div>
  );
}
