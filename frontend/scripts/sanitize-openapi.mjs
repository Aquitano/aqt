import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const [inputPath, outputPath] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  console.error("Usage: node scripts/sanitize-openapi.mjs <input> <output>");
  process.exit(1);
}

const spec = JSON.parse(await readFile(inputPath, "utf8"));
spec.components ??= {};
spec.components.schemas ??= {};

// Ktor currently emits refs to these inline/sealed DTO schemas without adding
// component entries. Keep this frontend-only shim small and remove it if the
// backend export starts emitting the components directly.
spec.components.schemas["JsonElement?"] ??= {
  type: ["object", "array", "string", "number", "boolean", "null"],
};

spec.components.schemas.StepIntervalDto ??= {
  type: "object",
  required: ["type", "startAt", "endAt", "steps"],
  properties: {
    type: { type: "string", const: "step_interval" },
    providerRecordId: { type: ["string", "null"] },
    startAt: { type: "string", format: "date-time" },
    endAt: { type: "string", format: "date-time" },
    steps: { type: "integer" },
  },
};

spec.components.schemas.SleepSessionDto ??= {
  type: "object",
  required: ["type", "startAt", "endAt", "stages"],
  properties: {
    type: { type: "string", const: "sleep_session" },
    providerRecordId: { type: ["string", "null"] },
    startAt: { type: "string", format: "date-time" },
    endAt: { type: "string", format: "date-time" },
    stages: {
      type: "array",
      items: {
        type: "object",
        required: ["stage", "startAt", "endAt"],
        properties: {
          stage: { type: "string" },
          startAt: { type: "string", format: "date-time" },
          endAt: { type: "string", format: "date-time" },
        },
      },
    },
  },
};

spec.components.schemas.BodyMeasurementDto ??= {
  type: "object",
  required: ["type", "measuredAt"],
  properties: {
    type: { type: "string", const: "body_measurement" },
    providerRecordId: { type: ["string", "null"] },
    measuredAt: { type: "string", format: "date-time" },
    weightKg: { type: ["number", "null"] },
    bodyFatPercent: { type: ["number", "null"] },
    muscleKg: { type: ["number", "null"] },
    waterPercent: { type: ["number", "null"] },
    visceralFatRating: { type: ["number", "null"] },
  },
};

spec.components.schemas.HeartRateDto ??= {
  type: "object",
  required: ["type", "measuredAt", "bpm"],
  properties: {
    type: { type: "string", const: "heart_rate" },
    providerRecordId: { type: ["string", "null"] },
    measuredAt: { type: "string", format: "date-time" },
    bpm: { type: "integer" },
    context: { type: ["string", "null"] },
  },
};

for (const pathItem of Object.values(spec.paths ?? {})) {
  for (const operation of Object.values(pathItem ?? {})) {
    if (!operation || typeof operation !== "object" || !Array.isArray(operation.parameters)) {
      continue;
    }
    for (const parameter of operation.parameters) {
      if (parameter?.name === "status" && parameter?.in === "query" && parameter.schema?.enum) {
        parameter.schema.enum = ["processed", "failed"];
        parameter.schema.example = "failed";
      }
      if (parameter?.name === "providerCode" && parameter?.in === "path" && parameter.schema?.enum) {
        parameter.schema.enum = parameter.schema.enum.map((value) =>
          value === "google_health" ? "google-health" : value,
        );
        parameter.schema.example = "withings";
      }
    }
  }
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(spec, null, 2)}\n`);
