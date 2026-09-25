"""Authoring helper. Prisma schema and SQL migration are committed outputs."""
from pathlib import Path
import json
root=Path(__file__).resolve().parents[1]
# Field types: s=text, u=UUID, t=timestamptz, d=money, q=quantity, j=JSONB,
# i=integer, b=boolean, date=date. A trailing ? allows NULL.
tables={
 'tenants': [('name','s'),('slug','s'),('branding','j'),('timezone','s',"Africa/Lagos"),('currency','s','NGN'),('currency_symbol','s','₦'),('schema_version','i',1)],
 'roles':[('name','s'),('permissions','j')],
 'users':[('name','s'),('email','s'),('phone','s?'),('password_hash','s'),('role_id','u'),('is_active','b',True),('force_password_change','b',True),('token_version','i',0)],
 'devices':[('label','s'),('local_ip','s?'),('assigned_department','s?'),('last_seen_at','t?'),('revoked_at','t?')],
 'guests':[('full_name','s'),('phone','s?'),('email','s?'),('id_type','s?'),('id_number','s?'),('address','s?'),('nationality','s?'),('notes','s?')],
 'room_types':[('name','s'),('base_rate','d'),('capacity','i'),('description','s?'),('amenities','j'),('online_allotment','i',0)],
 'rooms':[('room_number','s'),('room_type_id','u'),('floor','i',0),('status','RoomStatus','available')],
 'rate_plans':[('room_type_id','u'),('name','s'),('rate','d'),('valid_from','date'),('valid_to','date')],
 'reservations':[('guest_id','u'),('room_id','u?'),('room_type_id','u'),('check_in_date','date'),('check_out_date','date'),('adults','i',1),('children','i',0),('rate','d'),('status','ReservationStatus','pending'),('source','BookingSource','walk_in'),('notes','s?'),('cloud_booking_id','u?')],
 'folios':[('reservation_id','u?'),('guest_id','u'),('status','FolioStatus','open'),('opened_at','t'),('closed_at','t?')],
 'service_categories':[('name','s'),('vat_enabled','b',True),('service_charge_enabled','b',True),('vat_rate','q','7.500'),('service_charge_rate','q','10.000')],
 'service_items':[('category_id','u'),('name','s'),('price','d'),('unit','s'),('is_active','b',True),('track_inventory','b',False),('inventory_item_id','u?'),('inventory_qty_per_unit','q','1.000')],
 'service_orders':[('folio_id','u?'),('category_id','u'),('room_id','u?'),('ordered_by','u'),('status','OrderStatus','pending'),('total','d'),('idempotency_key','s')],
 'service_order_items':[('order_id','u'),('service_item_id','u'),('quantity','q'),('unit_price','d'),('subtotal','d')],
 'folio_charges':[('folio_id','u'),('source_type','s'),('source_id','u?'),('description','s'),('amount','d'),('charged_at','t'),('reversal_of_id','u?')],
 'payments':[('folio_id','u?'),('order_id','u?'),('amount','d'),('method','PaymentMethod'),('reference','s?'),('received_by','u'),('paid_at','t'),('gateway_reference','s?'),('reversal_of_id','u?'),('idempotency_key','s')],
 'receipts':[('receipt_number','s'),('folio_id','u?'),('order_id','u?'),('payload','j'),('printed_at','t?'),('reversal_of_id','u?')],
 'receipt_reprints':[('receipt_id','u'),('requested_by','u'),('printed_at','t'),('reason','s')],
 'receipt_counters':[('counter_device','s'),('next_number','i',1)],
 'shifts':[('user_id','u'),('opened_at','t'),('closed_at','t?'),('opening_float','d'),('closing_cash','d?'),('variance','d?')],
 'housekeeping_tasks':[('room_id','u'),('assigned_to','u?'),('type','s'),('status','TaskStatus','pending'),('notes','s?'),('completed_at','t?')],
 'inventory_items':[('name','s'),('unit','s'),('quantity_on_hand','q','0.000'),('reorder_level','q','0.000'),('category','s')],
 'inventory_movements':[('item_id','u'),('change_qty','q'),('reason','s'),('reference_id','u?'),('moved_by','u')],
 'online_bookings':[('payload','j'),('matched_reservation_id','u?'),('processed','b',False),('status','OnlineStatus','pending'),('external_reference','s'),('notification_status','s','pending')],
 'payment_transactions':[('gateway','Gateway'),('reference','s'),('amount','d'),('status','s'),('raw_response','j'),('verified_at','t?')],
 'audit_log':[('user_id','u?'),('action','s'),('entity','s'),('entity_id','u'),('before','j?'),('after','j?'),('occurred_at','t')],
 'sync_queue':[('table_name','s'),('record_id','u'),('operation','SyncOperation'),('payload','j'),('attempts','i',0),('last_error','s?'),('status','SyncStatus','pending'),('sent_at','t?'),('next_attempt_at','t?'),('source_updated_at','t')],
 'sync_metadata':[('table_name','s'),('record_id','u'),('synced','b',False),('last_synced_at','t?'),('source_updated_at','t')],
 'settings':[('key','s'),('value','j')],
 'refresh_sessions':[('user_id','u'),('token_hash','s'),('family_id','u'),('expires_at','t'),('revoked_at','t?'),('replaced_by_id','u?')],
 'gateway_credentials':[('gateway','Gateway'),('key_version','i',1),('encrypted_payload','s')],
 'license_cache':[('installation_id','u'),('signed_token','s'),('last_checked_at','t'),('max_observed_at','t')],
 'subscriptions':[('plan','PlanTier'),('status','SubscriptionStatus','trial'),('trial_ends_at','t?'),('period_ends_at','t?'),('features','j'),('max_devices','i',8),('max_rooms','i',50)],
 'licenses':[('key_hash','s'),('installation_id','u?'),('issued_at','t'),('revoked_at','t?')],
 'subscription_billing':[('amount','d'),('currency','s','NGN'),('description','s'),('reference','s'),('paid_at','t?')],
 'hub_heartbeats':[('installation_id','u'),('hub_version','s'),('schema_version','i'),('last_sync_at','t?'),('device_count','i',0),('room_count','i',0),('pending_count','i',0),('failed_count','i',0),('errors','j'),('seen_at','t')],
 'notifications':[('online_booking_id','u'),('channel','s'),('destination','s'),('payload','j'),('status','s','pending'),('attempts','i',0)],
 'draft_submissions':[('idempotency_key','s'),('kind','s'),('payload','j'),('submitted_by','u'),('applied_entity_id','u?')],
 'provider_audit':[('actor','s'),('action','s'),('payload','j')],
}
enums={'RoomStatus':'available occupied reserved dirty maintenance','ReservationStatus':'pending confirmed checked_in checked_out cancelled no_show','BookingSource':'walk_in phone online','FolioStatus':'open closed','OrderStatus':'pending served cancelled','PaymentMethod':'cash pos transfer online','Gateway':'paystack flutterwave','SyncOperation':'insert update','SyncStatus':'pending sent failed','TaskStatus':'pending in_progress completed cancelled','OnlineStatus':'pending confirmed rejected','SubscriptionStatus':'trial active past_due suspended cancelled','PlanTier':'standard premium'}
refs={'users':{'role_id':'roles'},'room_types':{},'rooms':{'room_type_id':'room_types'},'rate_plans':{'room_type_id':'room_types'},'reservations':{'guest_id':'guests','room_id':'rooms','room_type_id':'room_types','cloud_booking_id':'online_bookings'},'folios':{'reservation_id':'reservations','guest_id':'guests'},'service_items':{'category_id':'service_categories','inventory_item_id':'inventory_items'},'service_orders':{'folio_id':'folios','category_id':'service_categories','room_id':'rooms','ordered_by':'users'},'service_order_items':{'order_id':'service_orders','service_item_id':'service_items'},'folio_charges':{'folio_id':'folios','reversal_of_id':'folio_charges'},'payments':{'folio_id':'folios','order_id':'service_orders','received_by':'users','reversal_of_id':'payments'},'receipts':{'folio_id':'folios','order_id':'service_orders','reversal_of_id':'receipts'},'receipt_reprints':{'receipt_id':'receipts','requested_by':'users'},'shifts':{'user_id':'users'},'housekeeping_tasks':{'room_id':'rooms','assigned_to':'users'},'inventory_movements':{'item_id':'inventory_items','moved_by':'users'},'online_bookings':{'matched_reservation_id':'reservations'},'audit_log':{'user_id':'users'},'refresh_sessions':{'user_id':'users','replaced_by_id':'refresh_sessions'},'notifications':{'online_booking_id':'online_bookings'},'draft_submissions':{'submitted_by':'users'}}
unique={'tenants':[['slug']],'roles':[['name']],'users':[['email']],'rooms':[['room_number']],'room_types':[['name']],'service_categories':[['name']],'service_orders':[['idempotency_key']],'payments':[['idempotency_key'],['gateway_reference']],'receipts':[['device_id','receipt_number']],'receipt_counters':[['counter_device']],'online_bookings':[['external_reference']],'payment_transactions':[['gateway','reference']],'settings':[['key']],'sync_metadata':[['table_name','record_id']],'refresh_sessions':[['token_hash']],'gateway_credentials':[['gateway']],'license_cache':[['installation_id']],'subscriptions':[[]],'licenses':[['key_hash']],'subscription_billing':[['reference']],'hub_heartbeats':[['installation_id']],'draft_submissions':[['idempotency_key']]}
base=[('id','u'),('tenant_id','u'),('created_at','t','now'),('updated_at','t','now'),('deleted_at','t?'),('device_id','s','hub'),('created_by','u?')]
types={'s':('String','@db.Text'),'u':('String','@db.Uuid'),'t':('DateTime','@db.Timestamptz(6)'),'date':('DateTime','@db.Date'),'d':('Decimal','@db.Decimal(12, 2)'),'q':('Decimal','@db.Decimal(12, 3)'),'i':('Int',''),'b':('Boolean',''),'j':('Json','@db.JsonB')}
lines=['generator client {\n provider = "prisma-client-js"\n}\ndatasource db {\n provider = "postgresql"\n url = env("DATABASE_URL")\n}\n']
for e,vals in enums.items():lines.append('enum '+e+' {\n '+'\n '.join(vals.split())+'\n}\n')
for table,fields in tables.items():
 lines.append('model '+table+' {')
 for f in base+fields:
  name,typ,*default=f; optional=typ.endswith('?'); typ=typ.rstrip('?'); pt,attr=types.get(typ,(typ,''))
  if name=='id':attr+=' @id' # IDs MUST be supplied by application randomUUID()
  if default:
   v=default[0]
   val='now()' if v=='now' else str(v).lower() if isinstance(v,(bool,int)) else v if typ in enums else json.dumps(v,ensure_ascii=False)
   attr+=' @default('+val+')'
  lines.append(f' {name} {pt}{"?" if optional else ""} {attr}')
 for fields2 in unique.get(table,[]):lines.append(' @@unique(['+', '.join(['tenant_id']+fields2)+'])')
 lines.append(' @@unique([tenant_id, id])\n @@index([tenant_id])')
 # Ownership FK is SQL-only to avoid cyclic bootstrap relation requirements in Prisma.
 lines.append(' @@index([tenant_id, created_by])')
 for col,target in refs.get(table,{}).items():
  optional=next(f[1] for f in fields if f[0]==col).endswith('?'); rn=table+'_'+col
  lines.append(f' rel_{col} {target}{"?" if optional else ""} @relation("{rn}", fields: [tenant_id, {col}], references: [tenant_id, id], onDelete: Restrict, onUpdate: Restrict)')
  lines.append(f' @@index([tenant_id, {col}])')
 for src,rs in refs.items():
  for col,target in rs.items():
   if target==table:lines.append(f' back_{src}_{col} {src}[] @relation("{src}_{col}")')
 for idx in {'reservations':['check_in_date, status'],'folios':['status'],'rooms':['status'],'payments':['paid_at'],'sync_queue':['status, next_attempt_at, created_at'],'audit_log':['occurred_at']}.get(table,[]):lines.append(f' @@index([tenant_id, {idx}])')
 lines.append('}\n')
(root/'packages/db/prisma/schema.prisma').write_text('\n'.join(lines))
(root/'scripts/schema-meta.json').write_text(json.dumps({'tables':list(tables),'refs':refs},indent=2))
