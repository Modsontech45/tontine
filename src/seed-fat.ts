/**
 * Fat seed: adds 6 months of realistic data on top of seed.ts.
 * Run seed.ts first, then: pnpm --filter api seed:fat
 */
import 'dotenv/config'
import argon2 from 'argon2'
import { prisma } from './lib/prisma'

function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d }
function addDays(d: Date, n: number) { const r = new Date(d); r.setDate(r.getDate() + n); return r }
function toDate(d: Date) { return new Date(d.toISOString().split('T')[0] + 'T00:00:00.000Z') }
function randInt(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min }
function randLat() { return 6.1376 + (Math.random() - 0.5) * 0.07 }
function randLng() { return 1.2123 + (Math.random() - 0.5) * 0.07 }

const FN = ['Ama','Abla','Afi','Akosua','Adzo','Kofi','Kwame','Yao','Koffi','Edem',
  'Mawuli','Sena','Dzifa','Esi','Delali','Akpene','Mawuena','Worlanyo','Sénam','Yayra',
  'Koku','Elo','Eyram','Kafui','Mawuko']
const LN = ['Agbeko','Ameke','Dovlo','Kpodo','Ametefe','Soglo','Mensah','Agboka','Kpotivi',
  'Amouzou','Agbeti','Adama','Afanou','Amah','Anipah','Akpalo','Akyem','Amegatse','Anago',
  'Kodzo','Nayo','Alolo','Tsatsu','Dewotor','Amega']
const ACTS = ['Commerçante tissus','Vendeuse marché','Couturière','Épicerie','Transporteur',
  'Mécanicien','Coiffure','Restaurant','Pharmacie','Boulangerie','Vente légumes','Grossiste',
  'Artisan','Maquillage','Télécoms','Pressing','Maroquinerie','Électronique','Librairie']

// Six 31-day windows going back 186 days
const PERIODS = [
  { start: daysAgo(186), end: daysAgo(155), status: 'PAID'   as const }, // P0 ~Apr
  { start: daysAgo(155), end: daysAgo(124), status: 'PAID'   as const }, // P1 ~May
  { start: daysAgo(124), end: daysAgo(93),  status: 'PAID'   as const }, // P2 ~Jun
  { start: daysAgo(93),  end: daysAgo(62),  status: 'CLOSED' as const }, // P3 ~Jul
  { start: daysAgo(62),  end: daysAgo(31),  status: 'CLOSED' as const }, // P4 ~Aug
  { start: daysAgo(31),  end: addDays(new Date(), 1), status: 'OPEN' as const }, // P5 current
]

// Client group → which periods they participate in
function groupFor(idx: number): number[] {
  if (idx < 40)  return [0,1,2,3,4,5] // Group A: full 6 months
  if (idx < 80)  return [2,3,4,5]     // Group B: 4 months
  if (idx < 135) return [4,5]          // Group C: 2 months
  return [5]                            // Group D: current month only
}

async function main() {
  console.log('🌱 Fat seed démarré...')

  const [superAdmin, admin, cashier] = await Promise.all([
    prisma.user.findFirstOrThrow({ where: { phone: '+22890000001' } }),
    prisma.user.findFirstOrThrow({ where: { phone: '+22890000002' } }),
    prisma.user.findFirstOrThrow({ where: { phone: '+22890000004' } }),
  ])

  const existingBatch1 = await prisma.stickerBatch.findFirst({ where: { fromNumber: 1 } })
  const existingBatch2 = await prisma.stickerBatch.findFirst({ where: { fromNumber: 101 } })
  if (!existingBatch1 || !existingBatch2) throw new Error('Run seed.ts first')

  // ── 1. New zones ─────────────────────────────────────────────────────────
  const [zone3, zone4, zone5] = await Promise.all([
    prisma.zone.upsert({ where: { name: 'Adidogomè' }, create: { id: crypto.randomUUID(), name: 'Adidogomè', description: 'Quartier Adidogomè' }, update: {} }),
    prisma.zone.upsert({ where: { name: 'Tokoin' }, create: { id: crypto.randomUUID(), name: 'Tokoin', description: 'Quartier Tokoin' }, update: {} }),
    prisma.zone.upsert({ where: { name: 'Baguida' }, create: { id: crypto.randomUUID(), name: 'Baguida', description: 'Quartier Baguida' }, update: {} }),
  ])
  const allZones = await prisma.zone.findMany()
  console.log(`✅ ${allZones.length} zones`)

  // ── 2. New collectors ──────────────────────────────────────────────────
  const pinHash = await argon2.hash('123456')
  const newCollectorDefs = [
    { phone: '+22892000001', firstName: 'Komlan',     lastName: 'Amega',    zoneId: zone3.id },
    { phone: '+22892000002', firstName: 'Kafui',      lastName: 'Dewotor',  zoneId: zone3.id },
    { phone: '+22892000003', firstName: 'Mawulikplim',lastName: 'Tsatsu',   zoneId: zone4.id },
    { phone: '+22892000004', firstName: 'Adekor',     lastName: 'Alolo',    zoneId: zone4.id },
    { phone: '+22892000005', firstName: 'Elom',       lastName: 'Awuitor',  zoneId: zone5.id },
    { phone: '+22892000006', firstName: 'Seyram',     lastName: 'Gbedema',  zoneId: zone5.id },
    { phone: '+22892000007', firstName: 'Kodzo',      lastName: 'Nayo',     zoneId: allZones[1].id },
  ]
  const newCollectors = await Promise.all(
    newCollectorDefs.map(c =>
      prisma.user.upsert({
        where: { phone: c.phone },
        create: { id: crypto.randomUUID(), role: 'COLLECTOR', firstName: c.firstName, lastName: c.lastName, phone: c.phone, pinHash, zoneId: c.zoneId, isActive: true },
        update: {},
      })
    )
  )
  const allCollectors = await prisma.user.findMany({ where: { role: 'COLLECTOR' } })
  console.log(`✅ ${allCollectors.length} collecteurs`)

  // ── 3. Devices for new collectors ─────────────────────────────────────
  const MODELS = ['Samsung A14', 'Tecno Spark 20', 'Itel S23', 'Infinix Hot 40']
  for (let i = 0; i < newCollectors.length; i++) {
    const c = newCollectors[i]
    const existing = await prisma.device.findFirst({ where: { userId: c.id } })
    if (!existing) {
      await prisma.device.create({
        data: {
          id: crypto.randomUUID(), userId: c.id,
          androidId: `android_${c.phone.replace('+', '')}`,
          model: MODELS[i % MODELS.length], appVersion: '1.0.0',
          status: 'APPROVED', approvedBy: admin.id, approvedAt: daysAgo(60),
          lastSyncAt: daysAgo(randInt(0, 2)),
        },
      })
    }
  }
  const deviceByCollector = new Map<string, string>()
  const allDevices = await prisma.device.findMany({ where: { status: 'APPROVED' } })
  for (const d of allDevices) deviceByCollector.set(d.userId, d.id)
  console.log('✅ Appareils configurés')

  // ── 4. Sticker batch 3 + sticker records 61-250 ───────────────────────
  const batch3 = await prisma.stickerBatch.upsert({
    where: { id: 'b0000003-0000-0000-0000-000000000003' },
    create: { id: 'b0000003-0000-0000-0000-000000000003', fromNumber: 201, toNumber: 400, printedAt: daysAgo(90), createdById: superAdmin.id },
    update: {},
  })

  const stickerRows = []
  for (let i = 61; i <= 250; i++) {
    const carnetNumber = `TP-${i.toString().padStart(6, '0')}`
    const collectorIndex = (i - 61) % allCollectors.length
    const batchId = i <= 100 ? existingBatch1.id : i <= 200 ? existingBatch2.id : batch3.id
    stickerRows.push({ carnetNumber, batchId, assignedCollectorId: allCollectors[collectorIndex].id, status: 'ASSIGNED' as const })
  }
  await prisma.carnetSticker.createMany({ data: stickerRows, skipDuplicates: true })
  console.log('✅ Stickers créés (61-250)')

  // ── 5. Clients 61-250 ─────────────────────────────────────────────────
  const clientRecords: Array<{ id: string; carnetNumber: string; collectorIndex: number; stakeAmount: number; groupPeriods: number[] }> = []

  for (let i = 0; i < 190; i++) {
    const num = i + 61
    const carnetNumber = `TP-${num.toString().padStart(6, '0')}`
    const existing = await prisma.client.findUnique({ where: { carnetNumber } })
    if (existing) { clientRecords.push({ id: existing.id, carnetNumber, collectorIndex: i % allCollectors.length, stakeAmount: [500,1000,1500,2000][i % 4], groupPeriods: groupFor(i) }); continue }

    const id = crypto.randomUUID()
    const collectorIndex = i % allCollectors.length
    const collector = allCollectors[collectorIndex]
    const zone = allZones.find(z => z.id === collector.zoneId) ?? allZones[0]
    const regDaysAgo = groupFor(i)[0] === 0 ? randInt(175, 190)
      : groupFor(i)[0] === 2 ? randInt(115, 130)
      : groupFor(i)[0] === 4 ? randInt(55, 70)
      : randInt(28, 35)

    await prisma.client.create({
      data: {
        id, carnetNumber,
        firstName: FN[i % FN.length], lastName: LN[i % LN.length],
        phone: `+2289${String(20000000 + i).padStart(8, '0')}`,
        activity: ACTS[i % ACTS.length],
        addressText: `Rue ${num}, Lomé`, landmark: 'Près du marché',
        latitude: randLat(), longitude: randLng(), gpsAccuracyM: randInt(3, 15),
        zoneId: zone.id, collectorId: collector.id, registeredById: collector.id,
        registeredAt: daysAgo(regDaysAgo), status: 'ACTIVE',
      },
    })
    await prisma.carnetSticker.update({ where: { carnetNumber }, data: { status: 'USED', usedByClientId: id } })
    clientRecords.push({ id, carnetNumber, collectorIndex, stakeAmount: [500,1000,1500,2000][i % 4], groupPeriods: groupFor(i) })
  }
  console.log(`✅ ${clientRecords.length} clients créés (61-250)`)

  // ── 6. Cycles + bulk collections ─────────────────────────────────────
  console.log('⏳ Génération des cycles et collections (patience)...')
  const allCollections: Array<{
    id: string; clientId: string; cycleId: string; collectorId: string; deviceId: string
    amount: number; stakeCount: string; isAppoint: boolean
    collectedAt: Date; businessDate: Date; receivedAt: Date
    latitude: number; longitude: number; gpsAccuracyM: number; distanceFromClientM: number
    flags: string[]
  }> = []
  const allCycles: Array<{
    id: string; clientId: string; cycleSequence: number
    startDate: Date; endDate: Date; stakeAmount: number; maxBoxes: number
    status: 'OPEN'|'CLOSED'|'PAID'|'CANCELLED'
    totalPaid: number; boxesFilled: number
    commissionAmount?: number; netToPay?: number; closedAt?: Date
  }> = []
  const payoutRows: Array<{
    id: string; cycleId: string; clientId: string
    totalPaid: number; commissionAmount: number; netPaid: number
    carnetVerified: boolean; cashierId: string; paidAt: Date
  }> = []

  for (const rec of clientRecords) {
    const collector = allCollectors[rec.collectorIndex]
    const deviceId = deviceByCollector.get(collector.id)
    if (!deviceId) continue

    const existingCycles = await prisma.cycle.findMany({ where: { clientId: rec.id } })
    if (existingCycles.length > 0) continue

    for (let pi = 0; pi < rec.groupPeriods.length; pi++) {
      const pIdx = rec.groupPeriods[pi]
      const period = PERIODS[pIdx]
      const seq = pi + 1
      const cycleId = crypto.randomUUID()
      const stake = rec.stakeAmount
      const isOpen = period.status === 'OPEN'

      // Generate daily collections (70% chance each day, skip some weekends)
      let currentDay = new Date(period.start)
      const endDay = isOpen ? new Date() : new Date(period.end)
      const dayCollections: { amount: number; date: Date }[] = []

      while (currentDay <= endDay) {
        const dow = currentDay.getDay()
        const collectProb = (dow === 0 || dow === 6) ? 0.3 : 0.72
        if (Math.random() < collectProb) {
          const stakes = randInt(1, 2)
          dayCollections.push({ amount: stakes * stake, date: new Date(currentDay) })
        }
        currentDay = addDays(currentDay, 1)
      }

      const totalPaid = dayCollections.reduce((s, c) => s + c.amount, 0)
      const boxesFilled = Math.min(31, Math.floor(totalPaid / stake))
      const commission = stake
      const isFinalised = !isOpen

      allCycles.push({
        id: cycleId, clientId: rec.id, cycleSequence: seq,
        startDate: toDate(period.start), endDate: toDate(period.end),
        stakeAmount: stake, maxBoxes: 31, status: period.status,
        totalPaid, boxesFilled,
        commissionAmount: isFinalised ? commission : undefined,
        netToPay: isFinalised ? totalPaid - commission : undefined,
        closedAt: isFinalised ? addDays(period.end, 1) : undefined,
      })

      if (period.status === 'PAID') {
        payoutRows.push({
          id: crypto.randomUUID(), cycleId, clientId: rec.id,
          totalPaid, commissionAmount: commission, netPaid: totalPaid - commission,
          carnetVerified: true, cashierId: cashier.id,
          paidAt: addDays(period.end, randInt(1, 4)),
        })
      }

      for (const col of dayCollections) {
        allCollections.push({
          id: crypto.randomUUID(), clientId: rec.id, cycleId, collectorId: collector.id, deviceId,
          amount: col.amount,
          stakeCount: (col.amount / stake).toFixed(2),
          isAppoint: false,
          collectedAt: col.date, businessDate: toDate(col.date), receivedAt: col.date,
          latitude: randLat(), longitude: randLng(), gpsAccuracyM: randInt(4, 20),
          distanceFromClientM: randInt(5, 120), flags: [],
        })
      }
    }
  }

  // Bulk insert cycles
  await prisma.cycle.createMany({ data: allCycles, skipDuplicates: true })
  console.log(`✅ ${allCycles.length} cycles insérés`)

  // Bulk insert collections in batches of 500
  for (let i = 0; i < allCollections.length; i += 500) {
    await prisma.collection.createMany({ data: allCollections.slice(i, i + 500), skipDuplicates: true })
    process.stdout.write(`\r  Collections: ${Math.min(i + 500, allCollections.length)}/${allCollections.length}`)
  }
  console.log(`\n✅ ${allCollections.length} collections insérées`)

  // Payouts
  await prisma.payout.createMany({ data: payoutRows, skipDuplicates: true })
  console.log(`✅ ${payoutRows.length} versements insérés`)

  // ── 7. Handovers (last 14 days) ────────────────────────────────────────
  const handoverRows = []
  for (let dayOffset = 14; dayOffset >= 1; dayOffset--) {
    const bizDate = toDate(daysAgo(dayOffset))
    for (const collector of allCollectors) {
      const existing = await prisma.cashHandover.findFirst({ where: { collectorId: collector.id, businessDate: bizDate } })
      if (existing) continue
      const dayColls = await prisma.collection.findMany({
        where: { collectorId: collector.id, businessDate: bizDate, voidedAt: null },
      })
      if (dayColls.length === 0) continue
      const expected = dayColls.reduce((s, c) => s + c.amount, 0)
      const gap = Math.random() < 0.1 ? randInt(-500, 500) : 0
      const received = expected + gap
      const status = dayOffset > 7 ? 'VALIDATED' : dayOffset > 3 ? 'CONFIRMED' : 'OPEN'

      handoverRows.push({
        id: crypto.randomUUID(), collectorId: collector.id, businessDate: bizDate,
        expectedAmount: expected, receivedAmount: status !== 'OPEN' ? received : undefined,
        difference: status !== 'OPEN' ? gap : undefined,
        collectionsCount: dayColls.length, status,
        cashierId: status !== 'OPEN' ? cashier.id : undefined,
        confirmedAt: status !== 'OPEN' ? addDays(bizDate, 1) : undefined,
        controllerId: status === 'VALIDATED' ? (await prisma.user.findFirst({ where: { role: 'CONTROLLER' } }))?.id : undefined,
        validatedAt: status === 'VALIDATED' ? addDays(bizDate, 2) : undefined,
      })
    }
  }
  // Insert handovers one by one to avoid constraint issues
  for (const h of handoverRows) {
    try {
      await prisma.cashHandover.create({ data: h as never })
    } catch { /* skip duplicate */ }
  }
  console.log(`✅ ${handoverRows.length} versements de caisse`)

  // ── 8. Extra alerts ────────────────────────────────────────────────────
  const alertTypes = [
    { type: 'GPS_FAR', severity: 'MEDIUM' as const, msg: 'Collecte effectuée à plus de 300m du client' },
    { type: 'LATE_SYNC', severity: 'LOW' as const, msg: 'Synchronisation en retard de plus de 48h' },
    { type: 'CASH_GAP', severity: 'HIGH' as const, msg: 'Écart de caisse détecté lors du versement' },
    { type: 'CLIENT_INACTIVE', severity: 'LOW' as const, msg: 'Client sans collecte depuis 7 jours' },
    { type: 'POSSIBLE_DUPLICATE', severity: 'MEDIUM' as const, msg: 'Collecte potentiellement en double' },
  ]
  const alertCountBefore = await prisma.alert.count()
  if (alertCountBefore < 30) {
    for (let i = 0; i < 28; i++) {
      const at = alertTypes[i % alertTypes.length]
      const collector = allCollectors[i % allCollectors.length]
      const clientRec = clientRecords[i % clientRecords.length]
      await prisma.alert.create({
        data: {
          id: crypto.randomUUID(), type: at.type, severity: at.severity,
          collectorId: collector.id,
          clientId: i % 3 !== 0 ? clientRec.id : undefined,
          message: at.msg,
          status: i < 10 ? 'OPEN' : i < 20 ? 'ACKNOWLEDGED' : 'RESOLVED',
          resolvedAt: i >= 20 ? daysAgo(randInt(1, 7)) : undefined,
        },
      })
    }
    console.log('✅ 28 alertes supplémentaires créées')
  }

  // ── 9. Extra void requests ─────────────────────────────────────────────
  const voidCountBefore = await prisma.voidRequest.count()
  if (voidCountBefore < 15) {
    const recentColls = await prisma.collection.findMany({
      where: { voidedAt: null },
      orderBy: { collectedAt: 'desc' },
      take: 14,
    })
    for (let i = 0; i < recentColls.length; i++) {
      const col = recentColls[i]
      const existing = await prisma.voidRequest.findFirst({ where: { collectionId: col.id } })
      if (existing) continue
      const status = i < 4 ? 'PENDING' : i < 10 ? 'APPROVED' : 'REJECTED'
      await prisma.voidRequest.create({
        data: {
          id: crypto.randomUUID(), collectionId: col.id,
          requestedById: allCollectors[i % allCollectors.length].id,
          reason: ['Client absent, collecte erronée','Double enregistrement','Montant incorrect','Client a refusé'][i % 4],
          status, decidedById: status !== 'PENDING' ? admin.id : undefined,
          decidedAt: status !== 'PENDING' ? daysAgo(randInt(1, 5)) : undefined,
          decisionNote: status === 'REJECTED' ? 'Pièce justificative insuffisante' : undefined,
        },
      })
    }
    console.log('✅ Demandes d\'annulation supplémentaires')
  }

  const totals = await Promise.all([
    prisma.client.count(),
    prisma.cycle.count(),
    prisma.collection.count(),
    prisma.alert.count(),
    prisma.cashHandover.count(),
  ])

  console.log('\n╔══════════════════════════════════╗')
  console.log(`║  Clients       : ${String(totals[0]).padStart(6)}          ║`)
  console.log(`║  Cycles        : ${String(totals[1]).padStart(6)}          ║`)
  console.log(`║  Collections   : ${String(totals[2]).padStart(6)}          ║`)
  console.log(`║  Alertes       : ${String(totals[3]).padStart(6)}          ║`)
  console.log(`║  Versements    : ${String(totals[4]).padStart(6)}          ║`)
  console.log('╚══════════════════════════════════╝')
  console.log('\n✅ Fat seed terminé !')
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
}).finally(() => prisma.$disconnect())
