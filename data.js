import { supabase } from './supabase.js';

const tableMap = {
  branches: 'branches',
  materials: 'materials',
  users: 'users',
  consumption: 'consumption_records',
  additions: 'stock_additions',
};

function client() {
  if (!supabase) throw new Error('إعدادات الاتصال بقاعدة البيانات غير مكتملة');
  return supabase;
}

export async function list(type, filters = {}) {
  const table = tableMap[type];
  let query = client().from(table).select(
    type === 'consumption'
      ? '*,materials(name,code,unit),branches:branches!consumption_records_branch_id_fkey(name),users!consumption_records_created_by_fkey(full_name)'
      : type === 'additions'
        ? '*,materials(name,code,unit),branches:branches!stock_additions_branch_id_fkey(name),users!stock_additions_added_by_fkey(full_name)'
        : '*'
  );
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== '' && value != null) query = query.eq(key, value);
  });
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function searchMaterials(query) {
  const safe = query.replace(/[,%()]/g, '');
  const { data, error } = await client().from('materials')
    .select('id,name,code,barcode,unit,category,default_price,scope,is_temp')
    .is('archived_at', null)
    .or(`name.ilike.%${safe}%,code.ilike.%${safe}%,barcode.ilike.%${safe}%`)
    .order('name')
    .limit(10);
  if (error) throw error;
  return data || [];
}

export async function insert(type, payload) {
  const { data, error } = await client().from(tableMap[type]).insert(payload).select();
  if (error) throw error;
  return data;
}

export async function update(type, id, payload) {
  const { data, error } = await client().from(tableMap[type]).update(payload).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function remove(type, id) {
  const { error } = await client().from(tableMap[type]).delete().eq('id', id);
  if (error) throw error;
}

export function hydrate(rows) {
  return rows.map(row => ({ ...row }));
}
