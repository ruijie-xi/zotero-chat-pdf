/** Validate the JSON Schema subset used by our registry in one place for every transport. */
export function validateToolArguments(value: unknown, schema: any, path = "arguments"): void {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const matches = (type: string) => {
    if (type === "null") return value === null;
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "array") return Array.isArray(value);
    if (type === "integer") return Number.isSafeInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    return typeof value === type;
  };
  if (!types.some(matches)) throw new Error(`${path} must have type ${types.join(" or ")}.`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} has an unsupported value.`);
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) {
    throw new Error(`${path} is outside its allowed range.`);
  }
  if (Array.isArray(value)) value.forEach((item, i) => validateToolArguments(item, schema.items, `${path}[${i}]`));
  else if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of schema.required || []) if (!Object.prototype.hasOwnProperty.call(object, key)) throw new Error(`${path}.${key} is required.`);
    for (const [key, item] of Object.entries(object)) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, key)) throw new Error(`${path}.${key} is not a supported parameter.`);
      validateToolArguments(item, schema.properties[key], `${path}.${key}`);
    }
  }
}
