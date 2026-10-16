import { prisma } from './prisma'
import { sendOtpEmail } from './email'

export async function requestOtp(userId: string, purpose: string): Promise<'sent' | 'no_email'> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, firstName: true, lastName: true },
  })
  if (!user?.email) return 'no_email'

  await prisma.otpCode.deleteMany({ where: { userId, purpose, usedAt: null } })

  const code = String(Math.floor(100000 + Math.random() * 900000))
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

  await prisma.otpCode.create({
    data: { id: crypto.randomUUID(), userId, code, purpose, expiresAt },
  })

  await sendOtpEmail({ to: user.email, firstName: user.firstName, code, purpose, expiresAt })
  return 'sent'
}

export async function verifyOtp(userId: string, purpose: string, code: string): Promise<boolean> {
  const otp = await prisma.otpCode.findFirst({
    where: { userId, purpose, code, usedAt: null, expiresAt: { gt: new Date() } },
  })
  if (!otp) return false

  await prisma.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } })
  return true
}
