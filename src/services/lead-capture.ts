import type { Lead } from '../types/agent';

export async function captureLead(
  kv: KVNamespace,
  params: {
    patient_name: string;
    phone_number: string;
    interest: string;
    urgency?: 'low' | 'medium' | 'high';
    notes?: string;
  },
): Promise<{ success: boolean; leadId: string; isExisting: boolean }> {
  // Dedup by phone number
  const existingLeadId = await kv.get(`leads:phone:${params.phone_number}`);
  if (existingLeadId) {
    // Update existing lead with new interest info
    const existing = await kv.get<Lead>(`lead:${existingLeadId}`, 'json');
    if (existing) {
      const updated: Lead = {
        ...existing,
        interest: params.interest,
        urgency: params.urgency ?? existing.urgency,
        notes: params.notes
          ? `${existing.notes ? existing.notes + '\n' : ''}${params.notes}`
          : existing.notes,
        updatedAt: Date.now(),
      };
      await kv.put(`lead:${existingLeadId}`, JSON.stringify(updated));
      return { success: true, leadId: existingLeadId, isExisting: true };
    }
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  const lead: Lead = {
    id,
    patientName: params.patient_name,
    phoneNumber: params.phone_number,
    interest: params.interest,
    urgency: params.urgency ?? 'medium',
    notes: params.notes,
    status: 'new',
    createdAt: now,
    updatedAt: now,
  };

  // Store the lead, phone index, and update the leads index
  await Promise.all([
    kv.put(`lead:${id}`, JSON.stringify(lead)),
    kv.put(`leads:phone:${params.phone_number}`, id),
    addToLeadsIndex(kv, id),
  ]);

  return { success: true, leadId: id, isExisting: false };
}

export async function getLead(kv: KVNamespace, id: string): Promise<Lead | null> {
  return kv.get<Lead>(`lead:${id}`, 'json');
}

export async function listLeads(
  kv: KVNamespace,
  statusFilter?: Lead['status'],
): Promise<Lead[]> {
  const index = await kv.get<string[]>('leads:index', 'json');
  if (!index || index.length === 0) return [];

  const leads = await Promise.all(
    index.map((id) => kv.get<Lead>(`lead:${id}`, 'json')),
  );

  const validLeads = leads.filter((lead): lead is Lead => lead !== null);

  if (statusFilter) {
    return validLeads.filter((lead) => lead.status === statusFilter);
  }

  return validLeads;
}

export async function updateLeadStatus(
  kv: KVNamespace,
  id: string,
  status: Lead['status'],
): Promise<Lead | null> {
  const lead = await kv.get<Lead>(`lead:${id}`, 'json');
  if (!lead) return null;

  const updated: Lead = { ...lead, status, updatedAt: Date.now() };
  await kv.put(`lead:${id}`, JSON.stringify(updated));
  return updated;
}

export async function notifyDoctor(
  webhookUrl: string,
  lead: Lead,
): Promise<void> {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'new_lead',
        lead: {
          name: lead.patientName,
          phone: lead.phoneNumber,
          interest: lead.interest,
          urgency: lead.urgency,
          notes: lead.notes,
        },
      }),
    });
  } catch (error) {
    // Fire-and-forget: log but don't throw
    console.error('Lead webhook notification failed:', error);
  }
}

async function addToLeadsIndex(kv: KVNamespace, id: string): Promise<void> {
  const index = await kv.get<string[]>('leads:index', 'json') ?? [];
  index.unshift(id); // Most recent first
  await kv.put('leads:index', JSON.stringify(index));
}
