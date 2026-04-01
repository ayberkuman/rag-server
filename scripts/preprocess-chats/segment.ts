import type { ParsedMessage } from './parse';

export interface Segment {
  messages: ParsedMessage[];
  startTime: Date;
  endTime: Date;
  participantNames: string[];
}

const TIME_GAP_HOURS = 3;
const MIN_SEGMENT_MESSAGES = 2;

/**
 * Split a conversation into topic segments based on time gaps.
 * A gap of 3+ hours between messages indicates a new topic/session.
 */
export function segmentConversation(messages: ParsedMessage[]): Segment[] {
  if (messages.length === 0) return [];

  const segments: Segment[] = [];
  let currentMessages: ParsedMessage[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const curr = messages[i];
    const gapMs = curr.timestamp.getTime() - prev.timestamp.getTime();
    const gapHours = gapMs / (1000 * 60 * 60);

    if (gapHours >= TIME_GAP_HOURS) {
      // Time gap detected — finalize current segment and start new one
      if (currentMessages.length >= MIN_SEGMENT_MESSAGES) {
        segments.push(buildSegment(currentMessages));
      }
      currentMessages = [curr];
    } else {
      currentMessages.push(curr);
    }
  }

  // Finalize last segment
  if (currentMessages.length >= MIN_SEGMENT_MESSAGES) {
    segments.push(buildSegment(currentMessages));
  }

  return segments;
}

function buildSegment(messages: ParsedMessage[]): Segment {
  const participants = new Set<string>();
  for (const msg of messages) {
    participants.add(msg.sender);
  }

  return {
    messages,
    startTime: messages[0].timestamp,
    endTime: messages[messages.length - 1].timestamp,
    participantNames: [...participants],
  };
}
