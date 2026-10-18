/** Minimal JSON Schema checks used when the user saves edited preview fields. */
export type JsonSchema = Record<string, unknown>;

export function validate(schema: JsonSchema, value: unknown, path = "input"): string[] {
  const errors: string[] = [];
  const type = schema.type;
  const types = Array.isArray(type) ? (type as string[]) : typeof type === "string" ? [type] : [];
  if (types.length && !types.some((t) => matchesType(t, value))) {
    errors.push(`${path} should be ${types.join(" or ")}`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
    errors.push(`${path} should be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path} is too long`);
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value)))
      errors.push(`${path} should be a date and time`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path} is below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path} is above ${schema.maximum}`);
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
    value.forEach((item, i) => errors.push(...validate(schema.items as JsonSchema, item, `${path}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (record[key] === undefined || record[key] === "") errors.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(props)) {
      if (record[key] !== undefined) errors.push(...validate(child, record[key], `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) if (!(key in props)) errors.push(`${path}.${key} is not allowed`);
    }
  }
  return errors;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}
