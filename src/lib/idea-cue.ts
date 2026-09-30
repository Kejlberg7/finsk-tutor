export type IdeaCue = { kind: "idea" | "correction"; content: string; explicit: boolean };

/** Keep automatic notes narrow: ordinary Finnish mistakes are lesson material, not app bugs. */
export function extractIdeaCues(utterance: string): IdeaCue[] {
  const text = utterance.trim();
  const explicit = text.match(
    /(?:^|[.!?]\s*)(?:kan du\s+|vil du\s+)?(?:not[eé]r|gem|husk)(?:\s+lige)?\s+(?:en\s+|et\s+)?(id[eé]|rettelse|fejl|bug|feature|funktion|ændring)(?:\s+til\s+appen)?\s*[:,-]?\s+(.+)$/i,
  );
  if (explicit) {
    const content = explicit[2].trim().slice(0, 1_500);
    return content.length < 5 ? [] : [{
      kind: /^(rettelse|fejl|bug|ændring)$/i.test(explicit[1]) ? "correction" : "idea",
      content,
      explicit: true,
    }];
  }

  const notes: IdeaCue[] = [];
  if (/(?:gemmer|gemning|status|checkpoint)/i.test(text)
    && /(?:afbryd|stopper|starte?\s+(?:samtalen\s+)?igen|trykke?\s+(?:på\s+)?knappen)/i.test(text)) {
    notes.push({ kind: "correction", content: "Samtalen afbrydes under løbende gemning, så jeg må starte den igen. Den skal fortsætte håndfrit.", explicit: false });
  }
  if (/(?:gemmer|gemning|starter?\s+(?:samtalen\s+)?igen|fortsætter)/i.test(text)
    && /(?:forfra|glemmer|ikke\s+(?:rigtig\s+)?ved|mister\s+(?:kontekst|tråden))/i.test(text)) {
    notes.push({ kind: "correction", content: "Efter gemning eller genstart mister tutoren tråden og gentager øvelser fra starten.", explicit: false });
  }
  if (/(?:kører\s+(?:lidt\s+|meget\s+)?(?:i\s+ring|rundt\s+i\s+det\s+samme)|gentager?\s+(?:det\s+samme|de\s+samme\s+ting))/i.test(text)) {
    notes.push({ kind: "correction", content: "Tutoren kører i ring og bør gå videre til nyt stof, når det kendte er øvet.", explicit: false });
  }
  if (/(?:ikke\s+(?:rigtig\s+)?et\s+hint|gav\s+(?:mig\s+)?(?:hele\s+)?svaret\s+som\s+hint)/i.test(text)) {
    notes.push({ kind: "correction", content: "Tutoren giver nogle gange hele svaret som et hint, så øvelsen ikke tester, hvad jeg husker.", explicit: false });
  }
  return notes;
}

export function extractIdeaCue(utterance: string): IdeaCue | null {
  return extractIdeaCues(utterance)[0] ?? null;
}
