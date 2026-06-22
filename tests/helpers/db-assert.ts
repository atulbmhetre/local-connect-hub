import { supabase, supabaseAdmin } from './setup';

export async function assertNotificationCreated(userPhone: string, type: string) {
  const { data } = await supabaseAdmin
    .from('user_notifications')
    .select()
    .eq('user_phone', userPhone)
    .eq('type', type)
    .order('created_at', { ascending: false })
    .limit(1);
  if (!data || data.length === 0) {
    throw new Error(`Expected notification of type '${type}' for ${userPhone} — not found`);
  }
  return data[0];
}

export async function assertRequestStatus(requestId: string, expectedStatus: string) {
  const { data } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', requestId)
    .single();
  if (data?.status !== expectedStatus) {
    throw new Error(`Expected request status '${expectedStatus}' but got '${data?.status}'`);
  }
}

export async function assertVendorField(vendorId: string, field: string, expectedValue: any) {
  const { data } = await supabase
    .from('vendors')
    .select(field)
    .eq('id', vendorId)
    .single();
  if ((data as any)?.[field] !== expectedValue) {
    throw new Error(`Expected vendors.${field} = '${expectedValue}' but got '${(data as any)?.[field]}'`);
  }
}

export async function assertRowExists(table: string, filters: Record<string, any>) {
  let query = supabaseAdmin.from(table).select('id');
  for (const [key, value] of Object.entries(filters)) {
    query = query.eq(key, value) as any;
  }
  const { data } = await query.limit(1);
  if (!data || data.length === 0) {
    throw new Error(`Expected row in '${table}' with ${JSON.stringify(filters)} — not found`);
  }
  return data[0];
}

export async function assertRowNotExists(table: string, filters: Record<string, any>) {
  let query = supabaseAdmin.from(table).select('id');
  for (const [key, value] of Object.entries(filters)) {
    query = query.eq(key, value) as any;
  }
  const { data } = await query.limit(1);
  if (data && data.length > 0) {
    throw new Error(`Expected NO row in '${table}' with ${JSON.stringify(filters)} — but found one`);
  }
}
