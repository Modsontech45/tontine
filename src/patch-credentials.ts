/**
 * One-time script: update Super Admin + Admin emails/passwords to real gmail accounts.
 * Run: npx ts-node -e "require('./src/patch-credentials')" OR via compiled dist
 */
import 'dotenv/config'
import argon2 from 'argon2'
import { prisma } from './lib/prisma'

async function main() {
  const hash = await argon2.hash('Mymoney12@')
  console.log('Hash ready')

  const emails = ['tandemodson55@gmail.com', 'tandemodson41@gmail.com']

  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) { console.log(`Not found: ${email}`); continue }
    await prisma.user.update({ where: { email }, data: { passwordHash: hash } })
    console.log(`Updated password for ${email} (role: ${user.role})`)
  }

  console.log('\nDone. Password for both accounts: Mymoney12@')
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
