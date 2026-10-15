/**
 * Seed script: creates realistic dev data for Tontine Prospera.
 * Run: pnpm seed (from monorepo root) or pnpm --filter api seed
 */
import 'dotenv/config'
import argon2 from 'argon2'
import { prisma } from './lib/prisma'

const LOME_LAT = 6.1376
const LOME_LNG = 1.2123

function randLat(base = LOME_LAT) { return base + (Math.random() - 0.5) * 0.04 }
function randLng(base = LOME_LNG) { return base + (Math.random() - 0.5) * 0.04 }
function randInt(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d }
function addDays(d: Date, n: number) { const r = new Date(d); r.setDate(r.getDate() + n); return r }
function toDate(d: Date) { return new Date(d.toISOString().split('T')[0] + 'T00:00:00.000Z') }

const FIRST_NAMES = ['Ama', 'Kofi', 'Abla', 'Kwame', 'Afi', 'Yao', 'Akosua', 'Koffi', 'Adzo', 'Edem', 'Mawuli', 'Sena', 'Dzifa', 'Yawo', 'Abena']
const LAST_NAMES = ['Agbeko', 'Ameke', 'Dovlo', 'Kpodo', 'Ametefe', 'Soglo', 'Amedzo', 'Tsikpo', 'Agboka', 'Kodzo', 'Kpotivi', 'Amouzou', 'Mensah', 'Agbeti', 'Ablavi']
const ACTIVITIES = ['Commerçante tissus', 'Vendeuse marché', 'Couturière', 'Épicerie', 'Transporteur', 'Mécanicien', 'Coiffure', 'Restaurant', 'Pharmacie', 'Boulangerie']

async function main() {
  console.log('Seeding database...')

  // Pre-compute hashes (expensive, do outside transaction)
  console.log('Hashing passwords...')
  const adminHash = await argon2.hash('Admin1234!')
  const pinHash = await argon2.hash('123456')
  console.log('Hashes ready')

  // Zones
  const [zone1, zone2] = await Promise.all([
    prisma.zone.upsert({ where: { name: 'Agoè' }, create: { id: crypto.randomUUID(), name: 'Agoè', description: 'Quartier Agoè-Nyivé' }, update: {} }),
    prisma.zone.upsert({ where: { name: 'Bè' }, create: { id: crypto.randomUUID(), name: 'Bè', description: 'Quartier Bè Kpota' }, update: {} }),
  ])
  console.log('Zones créées')

  // Users
  const superAdmin = await prisma.user.upsert({
    where: { phone: '+22890000001' },
    create: { id: crypto.randomUUID(), role: 'SUPER_ADMIN', firstName: 'Super', lastName: 'Admin', phone: '+22890000001', email: 'admin@tontineprospera.tg', passwordHash: adminHash, isActive: true },
    update: {},
  })
  const admin = await prisma.user.upsert({
    where: { phone: '+22890000002' },
    create: { id: crypto.randomUUID(), role: 'ADMIN', firstName: 'Ibrahim', lastName: 'Soumanou', phone: '+22890000002', email: 'ibrahim@tontineprospera.tg', passwordHash: adminHash, isActive: true },
    update: {},
  })
  await prisma.user.upsert({
    where: { phone: '+22890000003' },
    create: { id: crypto.randomUUID(), role: 'CONTROLLER', firstName: 'Kafui', lastName: 'Agbeko', phone: '+22890000003', passwordHash: adminHash, zoneId: zone1.id, isActive: true },
    update: {},
  })
  const cashier = await prisma.user.upsert({
    where: { phone: '+22890000004' },
    create: { id: crypto.randomUUID(), role: 'CASHIER', firstName: 'Esinam', lastName: 'Mensah', phone: '+22890000004', passwordHash: adminHash, isActive: true },
    update: {},
  })
  const collectors = await Promise.all([
    prisma.user.upsert({ where: { phone: '+22891000001' }, create: { id: crypto.randomUUID(), role: 'COLLECTOR', firstName: 'Kokou', lastName: 'Ameke', phone: '+22891000001', pinHash, zoneId: zone1.id, isActive: true }, update: {} }),
    prisma.user.upsert({ where: { phone: '+22891000002' }, create: { id: crypto.randomUUID(), role: 'COLLECTOR', firstName: 'Akoua', lastName: 'Dovlo', phone: '+22891000002', pinHash, zoneId: zone2.id, isActive: true }, update: {} }),
    prisma.user.upsert({ where: { phone: '+22891000003' }, create: { id: crypto.randomUUID(), role: 'COLLECTOR', firstName: 'Yves', lastName: 'Kpodo', phone: '+22891000003', pinHash, zoneId: zone1.id, isActive: true }, update: {} }),
  ])
  console.log('Utilisateurs créés')

  // Sticker batches
  const batch1 = await prisma.stickerBatch.upsert({
    where: { id: 'b0000001-0000-0000-0000-000000000001' },
    create: { id: 'b0000001-0000-0000-0000-000000000001', fromNumber: 1, toNumber: 100, printedAt: daysAgo(60), createdById: superAdmin.id },
    update: {},
  })
  const batch2 = await prisma.stickerBatch.upsert({
    where: { id: 'b0000002-0000-0000-0000-000000000002' },
    create: { id: 'b0000002-0000-0000-0000-000000000002', fromNumber: 101, toNumber: 200, printedAt: daysAgo(30), createdById: superAdmin.id },
    update: {},
  })

  // Stickers for 60 clients
  for (let i = 1; i <= 60; i++) {
    const carnetNumber = `TP-${i.toString().padStart(6, '0')}`
    const collectorIndex = (i - 1) % 3
    await prisma.carnetSticker.upsert({
      where: { carnetNumber },
      create: { carnetNumber, batchId: i <= 30 ? batch1.id : batch2.id, assignedCollectorId: collectors[collectorIndex].id, status: 'ASSIGNED' },
      update: {},
    })
  }
  console.log('Stickers créés')

  // Devices (approved)
  const DEVICE_IDS = [
    'd0000001-0000-0000-0000-000000000001',
    'd0000002-0000-0000-0000-000000000002',
    'd0000003-0000-0000-0000-000000000003',
  ]
  const devices = await Promise.all(
    collectors.map((c, i) =>
      prisma.device.upsert({
        where: { id: DEVICE_IDS[i] },
        create: { id: DEVICE_IDS[i], userId: c.id, androidId: `android_${c.phone.replace('+', '')}`, model: 'Samsung A23', appVersion: '1.0.0', status: 'APPROVED', approvedBy: admin.id, approvedAt: daysAgo(55), lastSyncAt: new Date() },
        update: {},
      })
    )
  )

  // Clients and cycles
  const clientIds: string[] = []
  const cycleStartDate = daysAgo(60)
  const cycleEndDate = addDays(cycleStartDate, 30)
  const cycle2StartDate = daysAgo(30)
  const cycle2EndDate = addDays(cycle2StartDate, 30)

  for (let i = 0; i < 60; i++) {
    const carnetNumber = `TP-${(i + 1).toString().padStart(6, '0')}`
    const collectorIndex = i % 3
    const collector = collectors[collectorIndex]
    const device = devices[collectorIndex]
    const zone = i < 30 ? zone1 : zone2
    const firstName = FIRST_NAMES[i % FIRST_NAMES.length]
    const lastName = LAST_NAMES[i % LAST_NAMES.length]
    const phone = `+2289${String(10000000 + i).padStart(8, '0')}`
    const stakeAmount = [500, 1000, 1500, 2000][i % 4]

    let clientId: string
    const existingClient = await prisma.client.findUnique({ where: { carnetNumber } })
    if (existingClient) {
      clientId = existingClient.id
    } else {
      clientId = crypto.randomUUID()
      await prisma.client.create({
        data: {
          id: clientId, carnetNumber, firstName, lastName, phone,
          activity: ACTIVITIES[i % ACTIVITIES.length],
          addressText: `Rue ${i + 1}, Lomé`, landmark: 'Non loin du marché',
          latitude: randLat(), longitude: randLng(), gpsAccuracyM: randInt(3, 15),
          zoneId: zone.id, collectorId: collector.id, registeredById: collector.id,
          registeredAt: daysAgo(randInt(30, 60)), status: 'ACTIVE',
        },
      })
      await prisma.carnetSticker.update({ where: { carnetNumber }, data: { status: 'USED', usedByClientId: clientId } })
    }
    clientIds.push(clientId)

    const existingCycles = await prisma.cycle.findMany({ where: { clientId } })
    if (existingCycles.length > 0) continue

    // Cycle 1 (PAID for 0-19, CLOSED for 20-39)
    if (i < 40) {
      const totalPaidC1 = stakeAmount * randInt(20, 31)
      const boxesFilledC1 = Math.min(31, Math.floor(totalPaidC1 / stakeAmount))
      const commissionC1 = stakeAmount
      const cycleId1 = crypto.randomUUID()

      await prisma.cycle.create({
        data: {
          id: cycleId1, clientId, cycleSequence: 1,
          startDate: toDate(cycleStartDate), endDate: toDate(cycleEndDate),
          stakeAmount, maxBoxes: 31,
          status: i < 20 ? 'PAID' : 'CLOSED',
          totalPaid: totalPaidC1, boxesFilled: boxesFilledC1,
          commissionAmount: commissionC1, netToPay: totalPaidC1 - commissionC1,
          closedAt: addDays(cycleEndDate, 1),
        },
      })

      // A few collections for cycle 1
      let remaining = totalPaidC1
      let currentDay = new Date(cycleStartDate)
      while (remaining > 0 && currentDay < cycleEndDate) {
        const stakes = Math.min(randInt(1, 2), Math.floor(remaining / stakeAmount)) || 1
        const amount = Math.min(stakes * stakeAmount, remaining)
        await prisma.collection.create({
          data: {
            id: crypto.randomUUID(), clientId, cycleId: cycleId1,
            collectorId: collector.id, deviceId: device.id,
            amount, stakeCount: (amount / stakeAmount).toFixed(2) as unknown as number,
            isAppoint: amount % stakeAmount !== 0,
            collectedAt: currentDay, businessDate: toDate(currentDay),
            receivedAt: currentDay,
            latitude: randLat(), longitude: randLng(), gpsAccuracyM: 10,
            distanceFromClientM: randInt(5, 50), flags: [],
          },
        })
        remaining -= amount
        currentDay = addDays(currentDay, randInt(1, 2))
      }

      if (i < 20) {
        await prisma.payout.create({
          data: {
            id: crypto.randomUUID(), cycleId: cycleId1, clientId,
            totalPaid: totalPaidC1, commissionAmount: commissionC1,
            netPaid: totalPaidC1 - commissionC1, carnetVerified: true,
            cashierId: cashier.id, paidAt: addDays(cycleEndDate, randInt(1, 5)),
          },
        })
      }
    }

    // Cycle 2 (OPEN)
    const daysInC2 = Math.max(1, Math.floor((Date.now() - cycle2StartDate.getTime()) / 86400000))
    const collectionsInC2 = randInt(Math.max(1, daysInC2 - 5), daysInC2)
    const totalPaidC2 = stakeAmount * collectionsInC2
    const boxesFilledC2 = Math.min(31, Math.floor(totalPaidC2 / stakeAmount))
    const cycleId2 = crypto.randomUUID()

    await prisma.cycle.create({
      data: {
        id: cycleId2, clientId, cycleSequence: i < 40 ? 2 : 1,
        startDate: toDate(cycle2StartDate), endDate: toDate(cycle2EndDate),
        stakeAmount, maxBoxes: 31, status: 'OPEN',
        totalPaid: totalPaidC2, boxesFilled: boxesFilledC2,
      },
    })

    let current2 = new Date(cycle2StartDate)
    let remaining2 = totalPaidC2
    while (remaining2 > 0 && current2 <= new Date()) {
      const amount = Math.min(stakeAmount * randInt(1, 2), remaining2)
      const isFarGps = i === 5
      const isOutsideHours = i === 10
      await prisma.collection.create({
        data: {
          id: crypto.randomUUID(), clientId, cycleId: cycleId2,
          collectorId: collector.id, deviceId: device.id,
          amount, stakeCount: (amount / stakeAmount).toFixed(2) as unknown as number,
          isAppoint: amount % stakeAmount !== 0,
          collectedAt: current2, businessDate: toDate(current2), receivedAt: current2,
          latitude: isFarGps ? randLat(LOME_LAT + 0.01) : randLat(),
          longitude: isFarGps ? randLng(LOME_LNG + 0.01) : randLng(),
          gpsAccuracyM: 10, distanceFromClientM: isFarGps ? 850 : randInt(5, 100),
          flags: [...(isFarGps ? ['GPS_FAR'] : []), ...(isOutsideHours ? ['OUTSIDE_HOURS'] : [])],
        },
      })
      remaining2 -= amount
      current2 = addDays(current2, 1)
    }
  }
  console.log('Clients, cycles et collections créés')

  // Default settings
  const settingEntries = [
    ['commission_strategy', 'ONE_STAKE'], ['stake_min', 100], ['stake_max', 10000],
    ['stake_step', 25], ['gps_alert_distance_m', 300], ['inactive_days', 5],
    ['spot_checks_per_collector_week', 5], ['sms_weekly_enabled', true],
    ['sms_unit_cost_xof', 30], ['office_phone', '+22890000001'],
    ['company_name', 'Tontine Prospera'], ['cycle_default_length', 31],
  ]
  for (const [key, value] of settingEntries) {
    await prisma.setting.upsert({
      where: { key: key as string },
      create: { key: key as string, value: value as never, updatedById: superAdmin.id, updatedAt: new Date() },
      update: {},
    })
  }
  console.log('Paramètres créés')

  // Void request anomaly
  const recentCollection = await prisma.collection.findFirst({ where: { clientId: clientIds[0] }, orderBy: { collectedAt: 'desc' } })
  if (recentCollection) {
    await prisma.voidRequest.upsert({
      where: { id: 'f0000001-0000-0000-0000-000000000001' },
      create: { id: 'f0000001-0000-0000-0000-000000000001', collectionId: recentCollection.id, requestedById: collectors[0].id, reason: 'Client absent, collecte erronée', status: 'PENDING' },
      update: {},
    })
  }

  // Alerts
  await prisma.alert.upsert({
    where: { id: 'e0000001-0000-0000-0000-000000000001' },
    create: { id: 'e0000001-0000-0000-0000-000000000001', type: 'CASH_GAP', severity: 'HIGH', collectorId: collectors[1].id, message: 'Écart de caisse: 2 000 F manquants lors du versement', status: 'OPEN' },
    update: {},
  })
  await prisma.alert.upsert({
    where: { id: 'e0000002-0000-0000-0000-000000000002' },
    create: { id: 'e0000002-0000-0000-0000-000000000002', type: 'GPS_FAR', severity: 'MEDIUM', collectorId: collectors[0].id, clientId: clientIds[5] ?? undefined, message: 'Collecte à 850m du client (seuil: 300m)', status: 'OPEN' },
    update: {},
  })
  console.log('Alertes et demandes d\'annulation créées')

  console.log('\n--- Accès ---')
  console.log('Super Admin: +22890000001 / Admin1234!')
  console.log('Admin: +22890000002 / Admin1234!')
  console.log('Contrôleur: +22890000003 / Admin1234!')
  console.log('Caissier: +22890000004 / Admin1234!')
  console.log('Collecteurs: +22891000001, +22891000002, +22891000003 / PIN: 123456')
  console.log('\nSeed terminé avec succès !')
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
}).finally(() => prisma.$disconnect())
