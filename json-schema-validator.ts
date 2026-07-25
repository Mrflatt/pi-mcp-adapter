import {
  Ajv,
  AjvJsonSchemaValidator,
  addFormats,
} from "@modelcontextprotocol/client/validators/ajv";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/client";

const DRAFT_07_SCHEMA_URIS = new Set([
  "http://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-07/schema",
]);

function schemaDialect(schema: JsonSchemaType): string | undefined {
  if (!("$schema" in schema) || typeof schema.$schema !== "string") return undefined;
  return schema.$schema.endsWith("#") ? schema.$schema.slice(0, -1) : schema.$schema;
}

export function createJsonSchemaValidator(): jsonSchemaValidator {
  const defaultValidator = new AjvJsonSchemaValidator();
  let draft07Validator: AjvJsonSchemaValidator | undefined;

  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      if (!DRAFT_07_SCHEMA_URIS.has(schemaDialect(schema) ?? "")) {
        return defaultValidator.getValidator<T>(schema);
      }

      draft07Validator ??= (() => {
        const ajv = new Ajv({
          strict: false,
          validateFormats: true,
          validateSchema: false,
          allErrors: true,
        });
        addFormats(ajv);
        return new AjvJsonSchemaValidator(ajv);
      })();
      return draft07Validator.getValidator<T>(schema);
    },
  };
}
