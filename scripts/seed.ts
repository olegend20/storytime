/**
 * Local development seed. Creates one family with two children so the nightly form and
 * library have something to show. Never run against production.
 *
 *   pnpm seed
 */
import { createClient } from '@supabase/supabase-js'

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

async function main(): Promise<void> {
  if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required to seed.')
  if (!URL.includes('127.0.0.1') && !URL.includes('localhost')) {
    throw new Error(`Refusing to seed a non-local database: ${URL}`)
  }

  const db = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } })

  const email = 'dev@storytime.test'
  const { data: created, error: userError } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
  })
  if (userError && !/already/i.test(userError.message)) throw userError

  let userId = created?.user?.id
  if (!userId) {
    const { data: list } = await db.auth.admin.listUsers()
    userId = list?.users.find((u) => u.email === email)?.id
  }
  if (!userId) throw new Error('could not resolve the seed user id')

  const { data: family, error: familyError } = await db
    .from('families')
    .upsert(
      { owner_user_id: userId, display_name: 'The Test Family', timezone: 'Europe/London' },
      { onConflict: 'owner_user_id' },
    )
    .select()
    .single()
  if (familyError) throw familyError

  await db.from('children').delete().eq('family_id', family.id)
  const { error: childError } = await db.from('children').insert([
    { family_id: family.id, first_name: 'Milo', age: 7, likes: ['LEGO', 'sharks'], notes: 'often the one with the idea' },
    { family_id: family.id, first_name: 'Juno', age: 4, likes: ['dinosaurs'], notes: 'loves shouting the sound words' },
  ])
  if (childError) throw childError

  console.log(`Seeded family ${family.id} for ${email} with 2 children.`)
  console.log('Log in via the magic link in the local inbucket at http://127.0.0.1:54324')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
