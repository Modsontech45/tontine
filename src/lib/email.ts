import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)
const FROM = (process.env.EMAIL_FROM ?? 'Tontine Prospera <onboarding@resend.dev>').replace(/^"|"$/g, '')
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Administrateur',
  ADMIN: 'Administrateur',
  CASHIER: 'Caissier',
  CONTROLLER: 'Contrôleur',
  COLLECTOR: 'Collecteur',
}

const PURPOSE_LABELS: Record<string, string> = {
  CONFIRM_HANDOVER: 'Confirmer un versement',
  DEACTIVATE_USER: 'Désactiver un utilisateur',
  VOID_COLLECTION: 'Annuler un encaissement',
  RESET_PASSWORD: 'Réinitialisation du mot de passe',
}

export async function sendHandoverAlert(opts: {
  collectorName: string
  businessDate: string
  expectedAmount: number
  receivedAmount: number
  difference: number
  cashierName: string
  confirmedAt: Date
}) {
  if (!ADMIN_EMAIL) return
  const { collectorName, businessDate, expectedAmount, receivedAmount, difference, cashierName, confirmedAt } = opts
  const diffColor = difference === 0 ? '#16a34a' : difference < 0 ? '#dc2626' : '#d97706'
  const diffText = difference === 0 ? '✓ Aucun écart' : difference > 0 ? `+${difference.toLocaleString('fr-FR')} F (surplus)` : `${difference.toLocaleString('fr-FR')} F (manquant)`

  await resend.emails.send({
    from: FROM,
    to: ADMIN_EMAIL,
    subject: `Versement confirmé — ${collectorName} — ${businessDate}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;color:#111;">
        <h2 style="color:#1e40af;">Versement confirmé</h2>
        <table style="border-collapse:collapse;width:100%;background:#f9fafb;border-radius:8px;margin:16px 0;">
          <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;">Collecteur</td><td style="padding:8px 12px;font-weight:600;">${collectorName}</td></tr>
          <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;">Date</td><td style="padding:8px 12px;font-weight:600;">${businessDate}</td></tr>
          <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;">Attendu</td><td style="padding:8px 12px;font-weight:600;">${expectedAmount.toLocaleString('fr-FR')} F CFA</td></tr>
          <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;">Reçu</td><td style="padding:8px 12px;font-weight:600;">${receivedAmount.toLocaleString('fr-FR')} F CFA</td></tr>
          <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;">Écart</td><td style="padding:8px 12px;font-weight:600;color:${diffColor};">${diffText}</td></tr>
          <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;">Caissier</td><td style="padding:8px 12px;">${cashierName}</td></tr>
          <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;">Confirmé à</td><td style="padding:8px 12px;">${confirmedAt.toLocaleTimeString('fr-FR', { timeZone: 'Africa/Lome' })}</td></tr>
        </table>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
        <p style="color:#9ca3af;font-size:12px;">Tontine Prospera</p>
      </div>
    `,
  })
}

export async function sendDailySummary(opts: {
  date: string
  collected: number
  collectionsCount: number
  versed: number
  versedsCount: number
  gap: number
  activeCollectors: number
  pendingVoids: number
  handovers: Array<{ collector: { firstName: string; lastName: string } | null; expectedAmount: number; receivedAmount: number | null; status: string }>
}) {
  if (!ADMIN_EMAIL) return
  const { date, collected, collectionsCount, versed, versedsCount, gap, activeCollectors, pendingVoids, handovers } = opts
  const gapColor = gap === 0 ? '#16a34a' : gap > 0 ? '#d97706' : '#dc2626'

  const handoverRows = handovers.map(h => `
    <tr>
      <td style="padding:6px 12px;">${h.collector?.firstName ?? ''} ${h.collector?.lastName ?? ''}</td>
      <td style="padding:6px 12px;text-align:right;">${h.expectedAmount.toLocaleString('fr-FR')} F</td>
      <td style="padding:6px 12px;text-align:right;">${(h.receivedAmount ?? 0).toLocaleString('fr-FR')} F</td>
      <td style="padding:6px 12px;text-align:center;color:${h.status === 'CONFIRMED' || h.status === 'VALIDATED' ? '#16a34a' : '#d97706'};">${h.status === 'CONFIRMED' || h.status === 'VALIDATED' ? '✓' : '⏳'}</td>
    </tr>
  `).join('')

  await resend.emails.send({
    from: FROM,
    to: ADMIN_EMAIL,
    subject: `Résumé du jour — ${date}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111;">
        <h2 style="color:#1e40af;">Résumé quotidien</h2>
        <p style="color:#6b7280;">${date}</p>
        <table style="border-collapse:collapse;width:100%;background:#f9fafb;border-radius:8px;margin:16px 0;">
          <tr><td style="padding:10px 12px;color:#6b7280;">Total encaissé</td><td style="padding:10px 12px;font-weight:700;font-size:18px;">${collected.toLocaleString('fr-FR')} F CFA</td><td style="padding:10px 12px;color:#6b7280;">${collectionsCount} encaissements</td></tr>
          <tr><td style="padding:10px 12px;color:#6b7280;">Total versé</td><td style="padding:10px 12px;font-weight:700;font-size:18px;">${versed.toLocaleString('fr-FR')} F CFA</td><td style="padding:10px 12px;color:#6b7280;">${versedsCount} versements</td></tr>
          <tr><td style="padding:10px 12px;color:#6b7280;">Écart</td><td style="padding:10px 12px;font-weight:700;font-size:18px;color:${gapColor};">${gap.toLocaleString('fr-FR')} F CFA</td><td></td></tr>
          <tr><td style="padding:10px 12px;color:#6b7280;">Collecteurs actifs</td><td style="padding:10px 12px;font-weight:600;">${activeCollectors}</td><td></td></tr>
          ${pendingVoids > 0 ? `<tr><td style="padding:10px 12px;color:#dc2626;">Annulations en attente</td><td style="padding:10px 12px;font-weight:600;color:#dc2626;">${pendingVoids}</td><td></td></tr>` : ''}
        </table>
        ${handovers.length > 0 ? `
        <h3 style="color:#374151;font-size:15px;">Versements du jour</h3>
        <table style="border-collapse:collapse;width:100%;font-size:13px;">
          <thead><tr style="background:#e5e7eb;">
            <th style="padding:6px 12px;text-align:left;">Collecteur</th>
            <th style="padding:6px 12px;text-align:right;">Attendu</th>
            <th style="padding:6px 12px;text-align:right;">Reçu</th>
            <th style="padding:6px 12px;text-align:center;">Statut</th>
          </tr></thead>
          <tbody>${handoverRows}</tbody>
        </table>` : '<p style="color:#6b7280;">Aucun versement enregistré aujourd\'hui.</p>'}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
        <p style="color:#9ca3af;font-size:12px;">Tontine Prospera — Résumé automatique</p>
      </div>
    `,
  })
}

export async function sendOtpEmail(opts: {
  to: string
  firstName: string
  code: string
  purpose: string
  expiresAt: Date
}) {
  const { to, firstName, code, purpose, expiresAt } = opts
  const label = PURPOSE_LABELS[purpose] ?? purpose
  const expiryStr = expiresAt.toLocaleTimeString('fr-FR', { timeZone: 'Africa/Lome', hour: '2-digit', minute: '2-digit' })

  await resend.emails.send({
    from: FROM,
    to,
    subject: `Code de vérification — ${label}`,
    html: `
      <div style="font-family:sans-serif;max-width:420px;margin:0 auto;color:#111;">
        <h2 style="color:#1e40af;">Code de vérification</h2>
        <p>Bonjour <strong>${firstName}</strong>,</p>
        <p>Votre code pour <strong>${label}</strong> :</p>
        <div style="text-align:center;margin:24px 0;">
          <span style="font-size:36px;font-weight:800;letter-spacing:12px;color:#1e40af;font-family:monospace;">${code}</span>
        </div>
        <p style="color:#6b7280;font-size:13px;">Ce code expire à ${expiryStr}. Ne le partagez avec personne.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
        <p style="color:#9ca3af;font-size:12px;">Tontine Prospera</p>
      </div>
    `,
  })
}

export async function sendWelcomeEmail(opts: {
  to: string
  firstName: string
  lastName: string
  role: string
  phone: string
  password?: string
  pin?: string
}) {
  const { to, firstName, lastName, role, phone, password, pin } = opts
  const credLabel = pin ? 'PIN mobile' : 'Mot de passe'
  const credValue = pin ?? password ?? ''

  await resend.emails.send({
    from: FROM,
    to,
    subject: 'Bienvenue sur Tontine Prospera',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;color:#111;">
        <h2 style="color:#1e40af;margin-bottom:4px;">Bienvenue sur Tontine Prospera</h2>
        <p>Bonjour <strong>${firstName} ${lastName}</strong>,</p>
        <p>Votre compte a été créé avec succès. Voici vos identifiants de connexion :</p>
        <table style="border-collapse:collapse;width:100%;margin:16px 0;background:#f9fafb;border-radius:8px;">
          <tr>
            <td style="padding:8px 12px;color:#6b7280;font-size:14px;">Rôle</td>
            <td style="padding:8px 12px;font-weight:600;">${ROLE_LABELS[role] ?? role}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;color:#6b7280;font-size:14px;">Téléphone</td>
            <td style="padding:8px 12px;font-weight:600;">${phone}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;color:#6b7280;font-size:14px;">${credLabel}</td>
            <td style="padding:8px 12px;font-weight:600;font-family:monospace;font-size:16px;">${credValue}</td>
          </tr>
        </table>
        <p style="color:#dc2626;font-size:13px;">⚠️ Veuillez changer votre mot de passe après la première connexion.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
        <p style="color:#9ca3af;font-size:12px;">Tontine Prospera — Système de gestion des tontines</p>
      </div>
    `,
  })
}
