import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import { buildQrPayload } from '../lib/qr'

interface StickerLabel {
  carnetNumber: string
  collectorName?: string
}

const LABELS_PER_ROW = 3
const ROWS_PER_PAGE = 8
const PAGE_MARGIN = 36
const LABEL_WIDTH = (595.28 - PAGE_MARGIN * 2) / LABELS_PER_ROW
const LABEL_HEIGHT = (841.89 - PAGE_MARGIN * 2 - 20) / ROWS_PER_PAGE
const QR_SIZE = 80

export async function generateStickerPdf(labels: StickerLabel[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, autoFirstPage: true })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    let col = 0
    let row = 0

    const drawLabel = async (label: StickerLabel) => {
      const x = PAGE_MARGIN + col * LABEL_WIDTH
      const y = PAGE_MARGIN + 20 + row * LABEL_HEIGHT

      // Border
      doc.rect(x + 2, y + 2, LABEL_WIDTH - 4, LABEL_HEIGHT - 4).stroke('#cccccc')

      // QR code as PNG data URL
      const qrPayload = buildQrPayload(label.carnetNumber)
      const qrDataUrl = await QRCode.toDataURL(qrPayload, { width: QR_SIZE, margin: 1, errorCorrectionLevel: 'M' })
      const qrBase64 = qrDataUrl.replace(/^data:image\/png;base64,/, '')
      const qrBuffer = Buffer.from(qrBase64, 'base64')

      const qrX = x + (LABEL_WIDTH - QR_SIZE) / 2
      const qrY = y + 8
      doc.image(qrBuffer, qrX, qrY, { width: QR_SIZE, height: QR_SIZE })

      // Carnet number
      doc.fontSize(10).font('Helvetica-Bold').text(label.carnetNumber, x + 4, qrY + QR_SIZE + 4, {
        width: LABEL_WIDTH - 8,
        align: 'center',
      })

      // Collector name (small)
      if (label.collectorName) {
        doc.fontSize(7).font('Helvetica').text(label.collectorName, x + 4, qrY + QR_SIZE + 16, {
          width: LABEL_WIDTH - 8,
          align: 'center',
        })
      }
    }

    // We need to draw labels asynchronously — collect all QR promises, draw page-by-page
    const drawAll = async () => {
      doc.fontSize(12).font('Helvetica-Bold').text('TONTINE PROSPERA — Carnets', PAGE_MARGIN, PAGE_MARGIN - 10, { align: 'left' })

      for (const label of labels) {
        if (col === 0 && row === 0 && labels.indexOf(label) > 0) {
          // already on a fresh position
        }
        await drawLabel(label)
        col++
        if (col >= LABELS_PER_ROW) {
          col = 0
          row++
          if (row >= ROWS_PER_PAGE && labels.indexOf(label) < labels.length - 1) {
            doc.addPage()
            row = 0
            col = 0
            doc.fontSize(12).font('Helvetica-Bold').text('TONTINE PROSPERA — Carnets (suite)', PAGE_MARGIN, PAGE_MARGIN - 10)
          }
        }
      }
      doc.end()
    }

    drawAll().catch(reject)
  })
}
