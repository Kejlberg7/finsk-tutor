export type IdeaCue = { kind: "idea" | "correction"; content: string };

export function extractIdeaCue(utterance: string): IdeaCue | null {
  const match = utterance.trim().match(
    /^(?:not[eé]r|gem|husk)(?:\s+lige)?\s+(?:en\s+|et\s+)?(id[eé]|rettelse|fejl|bug|feature|funktion|ændring)(?:\s+til\s+appen)?\s*[:,-]?\s+(.+)$/i,
  );
  if (!match) return null;
  const content = match[2].trim().slice(0, 1_500);
  if (content.length < 5) return null;
  return {
    kind: /^(rettelse|fejl|bug|ændring)$/i.test(match[1]) ? "correction" : "idea",
    content,
  };
}
