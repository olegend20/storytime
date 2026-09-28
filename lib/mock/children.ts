import type { Child } from '@/lib/schemas'
import { fixtureFamilyId } from './store'

/**
 * The fixture family's children. Cruz 7 / Phoenix 4 / Lennon 10 follows DECISIONS.md #23,
 * so lane 4's screens, lane 2's pipeline and lane 5's eval all talk about the same kids.
 *
 * Only the five fields the closed schema allows (F11): first name, age, likes, notes,
 * reading level.
 */
export const MOCK_CHILDREN: readonly Child[] = [
  {
    id: 'c1111111-1111-4111-8111-111111111111',
    family_id: fixtureFamilyId(),
    first_name: 'Cruz',
    age: 7,
    likes: ['LEGO', 'sharks', 'building towers'],
    notes: null,
    reading_level: 'typical',
  },
  {
    id: 'c2222222-2222-4222-8222-222222222222',
    family_id: fixtureFamilyId(),
    first_name: 'Phoenix',
    age: 4,
    likes: ['dinosaurs', 'diggers'],
    notes: null,
    reading_level: 'younger',
  },
  {
    id: 'c3333333-3333-4333-8333-333333333333',
    family_id: fixtureFamilyId(),
    first_name: 'Lennon',
    age: 10,
    likes: ['Roblox', 'building games in Roblox Studio', 'soccer'],
    notes: null,
    reading_level: 'older',
  },
]
