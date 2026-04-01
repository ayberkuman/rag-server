export interface ParsedMessage {
  timestamp: Date;
  sender: string;
  text: string;
}

export interface ParsedChat {
  filename: string;
  patientName: string;
  messages: ParsedMessage[];
}

/**
 * Parse a WhatsApp .txt export file into structured messages.
 *
 * WhatsApp export format:
 *   [DD.MM.YYYY, HH:MM:SS] Sender: Message text
 *   [M/D/YY, H:MM:SS AM] Sender: Message text
 *
 * Multi-line messages: continuation lines lack the timestamp prefix.
 * System messages (encryption notices, group changes) are filtered out.
 */
export function parseWhatsAppExport(
  content: string,
  filename: string,
): ParsedChat {
  const lines = content.split('\n');
  const messages: ParsedMessage[] = [];

  // Match common WhatsApp timestamp formats
  // [DD.MM.YYYY, HH:MM:SS] or [M/D/YY, H:MM:SS AM/PM] or [DD/MM/YYYY, HH:MM:SS]
  const timestampPattern =
    /^\[(\d{1,2}[./]\d{1,2}[./]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\]\s*/i;

  for (const line of lines) {
    const match = line.match(timestampPattern);

    if (match) {
      const dateStr = match[1];
      const timeStr = match[2];
      const rest = line.slice(match[0].length);

      // Split "Sender: Message"
      const colonIndex = rest.indexOf(': ');
      if (colonIndex === -1) continue; // System message (no sender)

      const sender = rest.slice(0, colonIndex).trim();
      const text = rest.slice(colonIndex + 2).trim();

      // Skip system messages
      if (isSystemMessage(sender, text)) continue;
      // Skip media placeholders
      if (text === '<Media omitted>' || text === '<Medya dahil edilmedi>') continue;

      const timestamp = parseTimestamp(dateStr, timeStr);
      if (!timestamp) continue;

      messages.push({ timestamp, sender, text });
    } else if (messages.length > 0 && line.trim()) {
      // Continuation of previous message (multi-line)
      messages[messages.length - 1].text += '\n' + line.trim();
    }
  }

  const patientName = extractPatientName(filename, messages);

  return { filename, patientName, messages };
}

function parseTimestamp(dateStr: string, timeStr: string): Date | null {
  try {
    // Normalize separators
    const parts = dateStr.split(/[./]/);
    if (parts.length !== 3) return null;

    let day: number, month: number, year: number;

    // Detect format: if first part > 12, it's DD/MM/YYYY
    // Otherwise, could be MM/DD/YYYY (US) — we default to DD/MM/YYYY (Turkish)
    day = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    year = parseInt(parts[2], 10);

    // Handle 2-digit years
    if (year < 100) year += 2000;

    // Parse time
    let hours: number, minutes: number, seconds = 0;
    const timeParts = timeStr.replace(/\s*[AP]M/i, '').split(':');
    hours = parseInt(timeParts[0], 10);
    minutes = parseInt(timeParts[1], 10);
    if (timeParts[2]) seconds = parseInt(timeParts[2], 10);

    // Handle AM/PM
    if (/PM/i.test(timeStr) && hours !== 12) hours += 12;
    if (/AM/i.test(timeStr) && hours === 12) hours = 0;

    return new Date(year, month - 1, day, hours, minutes, seconds);
  } catch {
    return null;
  }
}

function isSystemMessage(sender: string, text: string): boolean {
  const systemIndicators = [
    'Messages and calls are end-to-end encrypted',
    'Mesajlar ve aramalar uçtan uca şifrelidir',
    'created group',
    'added',
    'removed',
    'left',
    'changed the subject',
    'changed this group',
    'changed the group',
  ];

  return systemIndicators.some(
    (indicator) =>
      text.includes(indicator) || sender.includes(indicator),
  );
}

function extractPatientName(
  filename: string,
  messages: ParsedMessage[],
): string {
  // Try to extract from filename: "WhatsApp Chat with John Doe.txt"
  const chatWithMatch = filename.match(/WhatsApp Chat with (.+)\.txt$/i);
  if (chatWithMatch) return chatWithMatch[1];

  // Try Turkish format: "WhatsApp John Doe ile sohbet.txt"
  const turkishMatch = filename.match(/WhatsApp (.+) ile sohbet\.txt$/i);
  if (turkishMatch) return turkishMatch[1];

  // Fallback: use the most common non-doctor sender
  if (messages.length === 0) return filename.replace('.txt', '');

  const senderCounts = new Map<string, number>();
  for (const msg of messages) {
    senderCounts.set(msg.sender, (senderCounts.get(msg.sender) ?? 0) + 1);
  }

  // The patient is usually the less frequent sender (doctor responds more)
  // But in case of ties or single sender, just pick the first non-doctor sender
  const sorted = [...senderCounts.entries()].sort((a, b) => a[1] - b[1]);
  return sorted[0]?.[0] ?? filename.replace('.txt', '');
}
