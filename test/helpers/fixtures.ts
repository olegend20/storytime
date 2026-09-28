import type Anthropic from '@anthropic-ai/sdk'
import { capabilities, fixtureKey, writeFixture, FIXTURE_ROOT } from '@/lib/ai'
import { StoryOutput, type StoryBible, type QualityReview, type StoryOutput as StoryOutputType } from '@/lib/schemas'
import type { CacheableBlock } from '@/lib/ai'

/**
 * SYNTHETIC model responses, written into the temp `FIXTURE_DIR` that `test/setup.ts`
 * installs - never into `test/fixtures/model/`, which is reserved for payloads recorded from
 * the real API (kickoff rule 3, and the note in that directory's README).
 *
 * What these are for, stated plainly so nobody mistakes their coverage:
 *
 *   These fixtures let the F6/F7 integration tests exercise OUR pipeline end to end - the
 *   streaming JSON scan, the SSE event order, the gate, the save, the quota call sites, the
 *   background bible update - without an API key. They prove the plumbing.
 *
 *   They prove NOTHING about whether a real writing-model call produces a story that passes
 *   the gate, hits the word target, or reads well. That needs recorded fixtures from a live
 *   run, and the tests which depend on real model judgement live in `test/blocked/` until a
 *   key is available. A synthetic fixture asserting "Haiku maps 'lego' to history-of-lego"
 *   would be a test of the test.
 */

/** Mirrors `streamModel`'s key computation. Kept in step by the tests that use it. */
export function streamFixtureKey(input: {
  model: string
  system?: CacheableBlock[]
  messages: Anthropic.MessageParam[]
  maxTokens: number
  thinking?: 'adaptive' | 'off'
}): string {
  const system = input.system?.map((b) => {
    const block: Record<string, unknown> = { type: 'text', text: b.text }
    if (b.cache) block.cache_control = { type: 'ephemeral' }
    return block
  })
  const mode = capabilities(input.model).thinking as string | undefined
  const thinking =
    input.thinking === 'adaptive' &&
    mode !== 'always_on_omit_param' &&
    mode !== 'extended_budget_tokens'
      ? { type: 'adaptive' as const }
      : undefined
  return fixtureKey({
    model: input.model,
    system,
    messages: input.messages,
    max_tokens: input.maxTokens,
    output_config: undefined,
    thinking,
  })
}

/** Mirrors `callModel`'s key computation for a call with no tools and no effort. */
export function callFixtureKey(input: {
  model: string
  system?: CacheableBlock[]
  messages: Anthropic.MessageParam[]
  maxTokens: number
  thinking?: 'adaptive' | 'off'
}): string {
  const system = input.system?.map((b) => {
    const block: Record<string, unknown> = { type: 'text', text: b.text }
    if (b.cache) block.cache_control = { type: 'ephemeral' }
    return block
  })
  const mode = capabilities(input.model).thinking as string | undefined
  const thinking =
    input.thinking === 'adaptive' &&
    mode !== 'always_on_omit_param' &&
    mode !== 'extended_budget_tokens'
      ? { type: 'adaptive' as const }
      : undefined
  return fixtureKey({
    model: input.model,
    system,
    messages: input.messages,
    tools: undefined,
    max_tokens: input.maxTokens,
    output_config: undefined,
    thinking,
  })
}

export interface StubUsage {
  input_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  output_tokens?: number
}

/** Write a synthetic fixture for `purpose` at `key`, whose single text block is `text`. */
export function stubFixture(
  purpose: string,
  key: string,
  text: string,
  usage: StubUsage = {},
): string {
  if (!FIXTURE_ROOT.includes('storytime-fixtures-')) {
    throw new Error(
      `Refusing to write a synthetic fixture into ${FIXTURE_ROOT}. That directory is for ` +
        `payloads recorded from the real API; test/setup.ts should have redirected FIXTURE_DIR ` +
        `to a temp directory.`,
    )
  }
  return writeFixture(purpose, key, {
    purpose: `${purpose} (SYNTHETIC - written by test/helpers/fixtures.ts, not recorded)`,
    model: 'synthetic',
    response: { content: [{ type: 'text', text }] },
    usage: {
      input_tokens: usage.input_tokens ?? 2_000,
      cache_read_tokens: usage.cache_read_tokens ?? 0,
      cache_write_tokens: usage.cache_write_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 5_000,
    },
    stop_reason: 'end_turn',
    recorded_at: '2026-09-27T00:00:00.000Z',
  })
}

/**
 * A band-A story that passes every deterministic check against `FIXTURE_FACT_PACK`.
 *
 * `fact_id`s are chosen from the facts whose `min_age` is 4 or less, because the youngest
 * child in the pipeline fixture is 4 and `fact_min_age` would otherwise fail - which is the
 * gate doing its job, not a bug in the stub.
 */
export function stubStory(overrides: Partial<StoryOutputType> = {}): StoryOutputType {
  const chapters = [
    {
      heading: 'Chapter 1: The Tower That Wobbled',
      text: [
        'It was a rainy Saturday, and Cruz and Phoenix had built the tallest LEGO tower their bedroom had ever seen. It wobbled. It swayed. It very nearly touched the lampshade.',
        '"One more brick," said Cruz, holding up a small red piece. "Then it is a world record."',
        'Phoenix pressed the brick on top. It went *click*. And then it began to glow.',
        'Not a little glow, either. The red spread across the carpet like spilled paint, up the wall, over the ceiling, until the whole room was the colour of a strawberry lolly.',
        '"Uh oh," said Phoenix.',
        '"Cool," said Cruz.',
        'The glow grew brighter and brighter, and with a great big WHOOOOSH, the boys were pulled right inside the brick.',
        'They landed on something soft. Snow. Real, cold, squeaky snow, in a village neither of them had ever seen.',
      ].join('\n\n'),
      shout_line: 'WHOOOOSH!',
    },
    {
      heading: 'Chapter 2: The Carpenter in Billund',
      text: [
        'The air smelled of fresh-cut wood. The houses had pointy roofs and small yellow windows, and a sign on a workshop door read **BILLUND, DENMARK**.',
        '"Denmark?" whispered Phoenix. "That is really far from home."',
        '"And look," said Cruz, pointing at a calendar nailed to the wall. "It says **1932**. That is nearly a hundred years ago!"',
        'Inside the workshop, a man with sawdust on his sleeves was sanding a small wooden duck. He looked up and smiled.',
        '"Hello. Are you two lost?"',
        '"Sort of," said Phoenix. "What are you making?"',
        'The man sighed. His name was **Ole Kirk Christiansen**, and he was a carpenter. "I used to build houses and furniture," he said. "But nobody has money for big things just now. So I make small things instead. Because even when times are hard, children still need to play."',
        'Cruz picked up the duck and pulled it across the floor. Quack-clack, quack-clack, went its wooden feet.',
        'Phoenix laughed so hard he had to sit down on a pile of shavings.',
        '"Every toy maker needs toy testers," said Ole. "Would you like the job?"',
      ].join('\n\n'),
      shout_line: null,
    },
    {
      heading: 'Chapter 3: A Name That Means Play Well',
      text: [
        'A couple of winters later, Ole gathered everybody around the workbench.',
        '"Our toys need a name," he said. "A special one."',
        '"How about Super Amazing Toy Company?" said Cruz.',
        '"How about Duck Company?" said Phoenix, who was still very attached to the duck.',
        'Ole chuckled. "Good ideas. But I have been thinking of two Danish words." He wrote them on a scrap of paper in careful, curly letters. "**Leg godt**. It means **play well**."',
        'Then he squished the two words together, took the first two letters of each, and wrote the answer underneath.',
        '**LEGO.**',
        '"LEGO!" shouted the boys. "That is perfect!"',
        'It was **1934**, and that is the name the company has had ever since.',
        '"Play well," said Ole, nodding slowly. "That is what every child deserves."',
        'Cruz said it back so loudly that a bird flew off the workshop roof.',
      ].join('\n\n'),
      shout_line: 'PLAY WELL!',
    },
    {
      heading: 'Chapter 4: The Night of the Fire',
      text: [
        'One night in **1942**, the boys woke up to shouting.',
        '"Fire! The workshop is on fire!"',
        'Orange light danced on the snow outside. Cruz grabbed Phoenix by the hand and they ran out with everybody else, and they all stood together in the cold and watched.',
        'Nobody was hurt. Not one person. But by morning the workshop and every toy inside it had gone.',
        'Ole stood in the ashes for a long time with his hands in his pockets. Phoenix tugged his sleeve.',
        '"Are you going to stop making toys?"',
        'Ole was quiet. Then he bent down, picked up a burned piece of wood, and turned it over in his hands.',
        '"No," he said. "We will build again. And we will build it better."',
        'And they did. Cruz carried planks until his arms ached. Phoenix walked up and down handing out nails, one at a time, very seriously. By the end of the summer a bigger, brighter workshop stood right where the old one had been.',
        '"You know what I always say," said Ole, patting the new wall. "**Only the best is good enough.**"',
      ].join('\n\n'),
      shout_line: null,
    },
    {
      heading: 'Chapter 5: The Machine That Went POP',
      text: [
        'The years flew past like pages in a flip book, and in **1947** an enormous crate arrived on a truck.',
        '"What IS that?" asked Cruz, as four men heaved it through the door.',
        'Inside was a clanking, hissing, steaming machine taller than Ole.',
        '"It melts plastic," said Ole, and his eyes were shining. "You squirt it into a shape, and out pops a toy. It cost more money than I have ever spent on anything. Some people think I have gone quite mad."',
        'The machine rumbled. CLUNK. HISSSS.',
        'POP!',
        'Out came a small, smooth block with round bumps along the top.',
        'Phoenix picked it up and turned it over. "It is a brick!"',
        'Cruz took another one and pressed it on top of the first. It sat there, balanced. Then he wiggled his hand, just a little, and the top brick fell straight off onto the floor.',
        'Plink.',
        '"Ah," said Ole. "Yes. That is our problem."',
      ].join('\n\n'),
      shout_line: 'POP!',
    },
    {
      heading: 'Chapter 6: Bricks That Would Not Stay',
      text: [
        'The new bricks were called **Automatic Binding Bricks**, which is a very grand name for something that would not bind at all.',
        'Towers tumbled. Castles crumbled. Bridges collapsed if you breathed on them. Some shops sent whole boxes back.',
        'Cruz built a garage six bricks high and slammed the door. The garage fell over. He built it again. It fell over again.',
        '"This is the most annoying toy in the world," he said, lying on his back on the floor.',
        'Then Ole’s son **Godtfred** came in waving his arms so fast he nearly knocked over a lamp.',
        '"I have been talking to a man who buys toys for shops," he said, "and he told me something important. There is no *system* in the toy business. Every toy is just one toy. You play with it, you get bored, that is the end."',
        'He scooped up a handful of bricks and let them clatter onto the bench.',
        '"So what if every LEGO set could join on to **every other** LEGO set? A house, a road, a fire station, a whole town. You could build it, and then build it again into something new."',
        '"Like a LEGO city!" said Phoenix.',
        '"Exactly like a LEGO city," said Godtfred. "There is only one teeny problem."',
        'All three of them looked at the sad little pile of bricks that would not stay together.',
      ].join('\n\n'),
      shout_line: null,
    },
    {
      heading: 'Chapter 7: The Tubes That Changed Everything',
      text: [
        'Godtfred and his team tried idea after idea. They drew pictures. They built models. They scratched their heads until their hair stood up.',
        'Cruz flipped a brick over and looked at the empty hollow underneath.',
        '"What if there was something **inside** here," he said slowly, "to hug the bumps on the brick below?"',
        'Godtfred stared at him. Then he grabbed a pencil and drew three little round **tubes** inside the bottom of the brick.',
        'They made a new brick with tubes in it. Phoenix held one brick in each hand, lined them up very carefully, and pressed.',
        '**CLICK!**',
        'He pulled. It held. He shook it. It held. He turned it upside down and shook it really, really hard.',
        '**It still held!**',
        '"IT CLICKS!" the boys yelled, jumping up and down. "IT REALLY CLICKS!"',
        'It was **28 January 1958**, and that is the day the brick with bumps on top and tubes underneath got its own patent. It is the very same click that holds your LEGO together tonight. A brick made back then still fits a brick made this year.',
        'Godtfred sat down on a stool and laughed until he had to wipe his eyes.',
      ].join('\n\n'),
      shout_line: 'IT CLICKS!',
    },
    {
      heading: 'Chapter 8: Home Again',
      text: [
        'The red brick in Phoenix’s pocket began to glow.',
        '"I think it is time to go home," said Cruz.',
        'Godtfred waved from the workbench. "Thank you for helping. Remember the rule!"',
        '"PLAY WELL!" shouted the boys together.',
        'WHOOOOOSH!',
        'And there they were, back on their own bedroom carpet, right beside their wobbly tower. It was still raining outside. Everything looked exactly the same, but it did not *feel* the same.',
        'Phoenix turned a brick over and looked at the little round tubes inside it.',
        '"A carpenter who kept going," he said. "A fire that could not stop him. A machine that went pop."',
        '"And a click that took years to figure out," said Cruz, grinning. "Kids helped, too. Kids like us."',
        'They got back to building. And this time, when the last brick went on top of the tower, it did not glow at all.',
        'It just went CLICK.',
        'And it held.',
      ].join('\n\n'),
      shout_line: 'CLICK!',
    },
  ]

  return StoryOutput.parse({
    title: 'Cruz, Phoenix and the Brick That Clicked',
    subtitle: 'A bedtime adventure through the true story of LEGO',
    chapters,
    ending_line: 'Goodnight, Cruz. Goodnight, Phoenix. Play well.',
    true_facts: [
      { text: 'LEGO began in **Billund, Denmark**, with a carpenter called **Ole Kirk Christiansen**, who started making wooden toys in **1932**.', fact_id: 'f1' },
      { text: 'The name LEGO comes from the Danish words **leg godt**, meaning **play well**.', fact_id: 'f2' },
      { text: 'One of the first wooden toys was a **pull-along duck** on wheels.', fact_id: 'f3' },
      { text: 'Ole Kirk started making toys because families had no money for houses and furniture.', fact_id: 'f4' },
      { text: 'The workshop burned down in **1942** and was rebuilt bigger. Nobody was hurt.', fact_id: 'f5' },
      { text: 'Ole Kirk’s motto was **only the best is good enough**.', fact_id: 'f6' },
      { text: 'The first plastic bricks were called **Automatic Binding Bricks** and did not hold together well.', fact_id: 'f8' },
      { text: '**Godtfred** realised every set should connect to every other set.', fact_id: 'f9' },
      { text: 'The answer was hollow **tubes** inside the brick, which grip the studs below.', fact_id: 'f10' },
    ],
    bible_suggestions: {
      new_recurring: [
        {
          name: 'The magic red LEGO brick',
          type: 'device',
          rule: 'glows and clicks to start an adventure, and brings them home at the end',
        },
      ],
      ending_summary:
        'Back home, the last brick on their wobbly tower went CLICK and finally held.',
    },
    estimated_read_minutes: 10,
    ...overrides,
  })
}

/** A story that reads as the rewrite: same shape, different title and ending image. */
export function stubRewrittenStory(): StoryOutputType {
  const base = stubStory()
  return {
    ...base,
    title: 'Cruz, Phoenix and the Brick That Finally Held',
    bible_suggestions: {
      ...base.bible_suggestions,
      ending_summary: 'Back home, the tower held and the red brick went quiet on the carpet.',
    },
  }
}

export const STUB_PASSING_REVIEW: QualityReview = {
  age_appropriate: true,
  scary_level: 0,
  kids_are_active_participants: true,
  facts_consistent_with_pack: true,
  tone_matches_request: true,
  reasons: [],
}

export function stubBible(children: StoryBible['children']): StoryBible {
  return {
    children,
    recurring: [
      {
        name: 'The magic red LEGO brick',
        type: 'device',
        rule: 'glows and clicks to start an adventure, and brings them home at the end',
      },
    ],
    catchphrases: ['Play well', 'WHOOOOSH'],
    topics_covered: [
      { topic: 'The history of LEGO', story_id: null, date: '2026-09-27' },
    ],
    last_story: {
      title: 'Cruz, Phoenix and the Brick That Clicked',
      ending: 'Back home, the last brick on their wobbly tower went CLICK and finally held.',
    },
    tone_history: ['funny', 'exciting'],
    avoid: ['travelling back to Billund two nights in a row'],
  }
}
