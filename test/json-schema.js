export function validateSchema(schema, data) {
  const errors = [];
  visit(schema, data, schema, "#", errors);
  return errors;
}

function visit(schema, data, root, pointer, errors) {
  if (schema.$ref) {
    visit(resolveRef(root, schema.$ref), data, root, pointer, errors);
    return errors;
  }
  if (schema.oneOf) {
    const matched = schema.oneOf.filter((branch) => visit(branch, data, root, pointer, []).length === 0);
    if (matched.length !== 1) {
      errors.push(`${pointer} must match exactly one schema`);
    }
    return errors;
  }
  if (schema.not && visit(schema.not, data, root, pointer, []).length === 0) {
    errors.push(`${pointer} is not allowed`);
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const") && data !== schema.const) {
    errors.push(`${pointer} has the wrong value`);
  }
  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${pointer} is not an allowed value`);
  }
  if (schema.type && !typeMatches(schema.type, data)) {
    errors.push(`${pointer} has the wrong type`);
    return errors;
  }
  if (typeof data === "string") {
    if (schema.minLength != null && data.length < schema.minLength) {
      errors.push(`${pointer} is too short`);
    }
    if (schema.maxLength != null && data.length > schema.maxLength) {
      errors.push(`${pointer} is too long`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(data)) {
      errors.push(`${pointer} has the wrong format`);
    }
  }
  if (schema.properties || schema.additionalProperties !== undefined || schema.required || schema.propertyNames) {
    if (data == null || typeof data !== "object" || Array.isArray(data)) {
      errors.push(`${pointer} must be an object`);
      return errors;
    }
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) {
        errors.push(`${pointer} is missing ${key}`);
      }
    }
    for (const [key, value] of Object.entries(data)) {
      if (schema.propertyNames) {
        visit(schema.propertyNames, key, root, `${pointer}/${key}`, errors);
      }
      if (schema.properties && Object.prototype.hasOwnProperty.call(schema.properties, key)) {
        visit(schema.properties[key], value, root, `${pointer}/${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${pointer} does not allow ${key}`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        visit(schema.additionalProperties, value, root, `${pointer}/${key}`, errors);
      }
    }
  }
  if (schema.items) {
    if (!Array.isArray(data)) {
      errors.push(`${pointer} must be an array`);
      return errors;
    }
    data.forEach((item, index) => visit(schema.items, item, root, `${pointer}/${index}`, errors));
  }
  return errors;
}

function resolveRef(root, ref) {
  if (!ref.startsWith("#/")) {
    throw new Error("Only local schema references are supported");
  }
  let node = root;
  for (const part of ref.slice(2).split("/")) {
    node = node[part];
  }
  return node;
}

function typeMatches(type, data) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((expected) => {
    if (expected === "object") {
      return data != null && typeof data === "object" && !Array.isArray(data);
    }
    if (expected === "array") {
      return Array.isArray(data);
    }
    if (expected === "integer") {
      return Number.isInteger(data);
    }
    if (expected === "null") {
      return data === null;
    }
    return typeof data === expected;
  });
}
