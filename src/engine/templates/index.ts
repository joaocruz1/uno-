import { EngineError } from "../errors";
import type { TemplateDefinition } from "./definition";
import { mercadoLivreTemplate } from "./mercado-livre";

export * from "./definition";
export { mercadoLivreTemplate };

/**
 * Released and draft layouts known to this engine build. Adding a marketplace
 * or carrier means adding its versioned definition here, plus synthetic
 * fixtures and the automated and physical evidence required for release.
 */
const REGISTRY: readonly TemplateDefinition[] = [mercadoLivreTemplate];

const identities = new Set<string>();
for (const definition of REGISTRY) {
  const identity = `${definition.key}@${definition.version}`;
  if (!/^[a-z0-9-]{1,80}@[0-9]+\.[0-9]+\.[0-9]+$/.test(identity) || identities.has(identity)) {
    throw new Error("Invalid or duplicate template definition");
  }
  identities.add(identity);
}

export function listTemplateDefinitions(): readonly TemplateDefinition[] {
  return REGISTRY;
}

export function findTemplateDefinition(
  key: string,
  version: string,
  definitions: readonly TemplateDefinition[] = REGISTRY,
): TemplateDefinition | undefined {
  return definitions.find((definition) => definition.key === key && definition.version === version);
}

/**
 * Narrows the candidates to an explicit selection (`key`, `key@version` or
 * `key:version`). A selection never forces a layout onto a document: the
 * detector still has to match it.
 */
export function selectTemplateDefinitions(
  selected: string | undefined,
  definitions: readonly TemplateDefinition[] = REGISTRY,
): readonly TemplateDefinition[] {
  if (!selected) return definitions;
  const matches = definitions.filter((definition) => [
    definition.key,
    `${definition.key}@${definition.version}`,
    `${definition.key}:${definition.version}`,
  ].includes(selected));
  if (matches.length === 0) throw new EngineError("unsupported_template");
  return matches;
}
