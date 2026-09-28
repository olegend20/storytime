import { FactPack, type FactPack as FactPackType } from '@/lib/schemas'

/**
 * A fixed, realistic LEGO fact pack for pipeline tests.
 *
 * Fixed rather than researched on purpose: the pack flows into the writer's prompt, so a
 * pack whose content varied between runs would change the prompt bytes and invalidate every
 * recorded story fixture. It is stored under a lane-2 topic key so it never occupies the real
 * `history-of-lego` row in the globally shared `fact_packs` table, where another lane would
 * find it and take it for research.
 *
 * The facts are the ones the LEGO reference story actually uses, so a story written from this
 * pack can hit the quality bar rather than being starved of material - and its True Facts
 * list has real ids to map onto.
 */

export const FIXTURE_TOPIC_KEY = 'lane2-fixture-history-of-lego'
export const FIXTURE_TOPIC_LABEL = 'The history of LEGO'

export const FIXTURE_FACT_PACK: FactPackType = FactPack.parse({
  topic_key: FIXTURE_TOPIC_KEY,
  topic_label: FIXTURE_TOPIC_LABEL,
  summary:
    'LEGO began in 1932 as a wooden-toy workshop in Billund, Denmark, run by a carpenter ' +
    'called Ole Kirk Christiansen. It took until 1958 for the company to work out the ' +
    'interlocking brick children know today, and the same bricks still fit together.',
  facts: [
    {
      id: 'f1',
      text: 'LEGO was founded in Billund, Denmark, by carpenter Ole Kirk Christiansen, who began making wooden toys in 1932.',
      kid_safe: true,
      min_age: 3,
      confidence: 'high',
      source_ids: ['s1'],
    },
    {
      id: 'f2',
      text: "The name comes from the Danish words 'leg godt', meaning 'play well', and was chosen in 1934.",
      kid_safe: true,
      min_age: 3,
      confidence: 'high',
      source_ids: ['s1', 's2'],
    },
    {
      id: 'f3',
      text: 'One of the first wooden toys was a pull-along wooden duck on wheels.',
      kid_safe: true,
      min_age: 3,
      confidence: 'high',
      source_ids: ['s2'],
    },
    {
      id: 'f4',
      text: 'Ole Kirk started making toys because the 1930s depression meant families had no money for houses and furniture.',
      kid_safe: true,
      min_age: 4,
      confidence: 'high',
      source_ids: ['s1'],
    },
    {
      id: 'f5',
      text: 'The workshop burned down in 1942 and Ole Kirk rebuilt it bigger than before; nobody was hurt.',
      kid_safe: true,
      min_age: 4,
      confidence: 'high',
      source_ids: ['s1'],
    },
    {
      id: 'f6',
      text: "Ole Kirk's motto was 'only the best is good enough', which he carved on a sign in the workshop.",
      kid_safe: true,
      min_age: 3,
      confidence: 'high',
      source_ids: ['s2'],
    },
    {
      id: 'f7',
      text: 'LEGO bought its first plastic-moulding machine in 1947, which cost about as much as several years of the company profits.',
      kid_safe: true,
      min_age: 5,
      confidence: 'medium',
      source_ids: ['s1'],
    },
    {
      id: 'f8',
      text: "The first plastic bricks, sold from 1949, were called Automatic Binding Bricks and did not hold together well.",
      kid_safe: true,
      min_age: 3,
      confidence: 'high',
      source_ids: ['s1', 's3'],
    },
    {
      id: 'f9',
      text: "Ole Kirk's son Godtfred realised toys needed a system, so that every set could connect to every other set.",
      kid_safe: true,
      min_age: 4,
      confidence: 'high',
      source_ids: ['s2'],
    },
    {
      id: 'f10',
      text: 'The solution was hollow tubes inside the underside of the brick, which grip the studs of the brick below.',
      kid_safe: true,
      min_age: 3,
      confidence: 'high',
      source_ids: ['s3'],
    },
    {
      id: 'f11',
      text: 'The modern LEGO brick was patented on 28 January 1958, and bricks made then still fit bricks made today.',
      kid_safe: true,
      min_age: 3,
      confidence: 'high',
      source_ids: ['s3'],
    },
    {
      id: 'f12',
      text: "Godtfred's son Kjeld Kirk Kristiansen tested new sets as a boy and later ran the whole company.",
      kid_safe: true,
      min_age: 4,
      confidence: 'high',
      source_ids: ['s2'],
    },
    {
      id: 'f13',
      text: 'LEGOLAND opened in Billund in 1968 and was built from millions of bricks.',
      kid_safe: true,
      min_age: 3,
      confidence: 'high',
      source_ids: ['s2'],
    },
    {
      id: 'f14',
      text: 'The LEGO minifigure, with its yellow smiling face and bendy legs, arrived in 1978.',
      kid_safe: true,
      min_age: 3,
      confidence: 'high',
      source_ids: ['s2'],
    },
    {
      id: 'f15',
      text: 'Two standard four-by-two bricks can be combined in 24 different ways, and six of them in more than 915 million ways.',
      kid_safe: true,
      min_age: 6,
      confidence: 'medium',
      source_ids: ['s3'],
    },
    {
      id: 'f16',
      text: 'People sometimes say LEGO makes more tyres each year than any car company; it is often repeated and hard to verify.',
      kid_safe: true,
      min_age: 6,
      confidence: 'legend',
      source_ids: ['s2'],
    },
  ],
  timeline: [
    { year: 1932, event: 'Ole Kirk Christiansen starts making wooden toys in Billund' },
    { year: 1934, event: "The company is named LEGO, from 'leg godt'" },
    { year: 1942, event: 'The workshop burns down and is rebuilt' },
    { year: 1947, event: 'The first plastic-moulding machine arrives' },
    { year: 1958, event: 'The modern interlocking brick is patented' },
    { year: 1968, event: 'LEGOLAND opens in Billund' },
    { year: 1978, event: 'The minifigure is introduced' },
  ],
  characters: [
    {
      name: 'Ole Kirk Christiansen',
      role: 'founder and carpenter',
      kid_friendly_note: 'a kind carpenter who kept going after losing everything twice',
    },
    {
      name: 'Godtfred Kirk Christiansen',
      role: "Ole Kirk's son, head of the company",
      kid_friendly_note: 'the one who realised toys should work as a system',
    },
    {
      name: 'Kjeld Kirk Kristiansen',
      role: 'grandson, later company head',
      kid_friendly_note: 'tested the sets as a boy and grew up to run the company',
    },
  ],
  sensitive_notes:
    'The 1942 fire destroyed the workshop but nobody was hurt: say so plainly and move on to the rebuilding.',
  sources: [
    { id: 's1', title: 'The LEGO Group history', url: 'https://www.lego.com/en-us/history' },
    { id: 's2', title: 'LEGO - Encyclopaedia entry', url: 'https://www.britannica.com/topic/Lego' },
    {
      id: 's3',
      title: 'Toy building brick patent, US 3,005,282',
      url: 'https://patents.google.com/patent/US3005282A/en',
    },
  ],
})
