import assert from "node:assert/strict";
import test from "node:test";
import { extractIdeaCue } from "../src/lib/idea-cue";
import { cleanFragments, compactTranscript, completedTurnCutoff } from "../src/lib/transcript";
import type { TranscriptLine } from "../src/lib/learning-types";

test("voice notes require a deliberate cue", () => {
  assert.deepEqual(extractIdeaCue("Notér idé: Vis mine sidste samtaler"), {
    kind: "idea", content: "Vis mine sidste samtaler",
  });
  assert.deepEqual(extractIdeaCue("Noter en rettelse: Lektionen gentager sig"), {
    kind: "correction", content: "Lektionen gentager sig",
  });
  assert.equal(extractIdeaCue("Gentag det finske ord igen"), null);
  assert.equal(extractIdeaCue("Husk ordet kiitos"), null);
});

test("checkpoints only score completed learner-and-tutor exchanges", () => {
  const fragments: TranscriptLine[] = [
    { speaker: "tutor", text: "Say kiitos." },
    { speaker: "dig", text: "Kiitos." },
    { speaker: "tutor", text: "Yes, correct." },
    { speaker: "dig", text: "What next?" },
  ];
  assert.equal(completedTurnCutoff(fragments), 3);
  assert.equal(completedTurnCutoff(fragments.slice(0, 3)), 1);
  assert.equal(completedTurnCutoff(fragments.slice(0, 1)), 0);
});

test("transcript fragments combine without dropping speech", () => {
  const result = compactTranscript([
    { speaker: "dig", text: "Notér " },
    { speaker: "dig", text: "idé: " },
    { speaker: "dig", text: "mere variation." },
    { speaker: "tutor", text: "Okay." },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, "Notér idé: mere variation.");
});

test("checkpoint cursor input rejects malformed fragments", () => {
  assert.throws(() => cleanFragments([{ speaker: "dig", text: "ok" }, { speaker: "other", text: "bad" }]));
  assert.equal(cleanFragments([{ speaker: "dig", text: "kiitos" }]).length, 1);
});
