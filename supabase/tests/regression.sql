\set ON_ERROR_STOP on
begin;

insert into auth.users(id) values
 ('00000000-0000-4000-8000-000000000101'), -- A approver
 ('00000000-0000-4000-8000-000000000102'), -- A ordinary member
 ('00000000-0000-4000-8000-000000000103'), -- inactive member
 ('00000000-0000-4000-8000-000000000201'); -- B approver
insert into public.tenants(id, name) values
 ('00000000-0000-4000-8000-000000000001', 'Tenant A'),
 ('00000000-0000-4000-8000-000000000002', 'Tenant B');
insert into public.tenant_members(tenant_id,user_id,role,active,access_allowed,access_start_date,access_end_date) values
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','owner',true,true,current_date-30,current_date+30),
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000102','member',true,true,current_date-30,current_date+30),
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000103','member',false,true,current_date-30,current_date+30),
 ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000201','owner',true,true,current_date-30,current_date+30);
insert into public.assets(id,tenant_id,title,assigned_approver_id,access_allowed,access_start_date,access_end_date,
 rights_status,rights_start_date,rights_end_date,allowed_channels,allowed_purposes) values
 ('00000000-0000-4000-8000-000000000301','00000000-0000-4000-8000-000000000001','A main','00000000-0000-4000-8000-000000000101',true,current_date-30,current_date+30,'valid',current_date-30,current_date+30,array['instagram'],array['organic']),
 ('00000000-0000-4000-8000-000000000302','00000000-0000-4000-8000-000000000002','B main','00000000-0000-4000-8000-000000000201',true,current_date-30,current_date+30,'valid',current_date-30,current_date+30,array['instagram'],array['organic']),
 ('00000000-0000-4000-8000-000000000303','00000000-0000-4000-8000-000000000001','A revision','00000000-0000-4000-8000-000000000101',true,current_date-30,current_date+30,'valid',current_date-30,current_date+30,array['instagram'],array['organic']);
insert into public.asset_versions(id,asset_id,tenant_id,version_number,preview_available,delivery_available,object_path,content_sha256)
 select v.id,a.id,a.tenant_id,v.number,true,true,a.tenant_id::text||'/'||a.id::text||'/'||v.id::text||'/delivery.mp4',repeat('a',64)
 from (values
  ('00000000-0000-4000-8000-000000000401'::uuid,'00000000-0000-4000-8000-000000000301'::uuid,1),
  ('00000000-0000-4000-8000-000000000402'::uuid,'00000000-0000-4000-8000-000000000301'::uuid,2),
  ('00000000-0000-4000-8000-000000000403'::uuid,'00000000-0000-4000-8000-000000000302'::uuid,1),
  ('00000000-0000-4000-8000-000000000404'::uuid,'00000000-0000-4000-8000-000000000303'::uuid,1)
 ) as v(id,asset_id,number) join public.assets a on a.id=v.asset_id;
update public.assets set latest_version_id = case id
 when '00000000-0000-4000-8000-000000000301' then '00000000-0000-4000-8000-000000000402'::uuid
 when '00000000-0000-4000-8000-000000000302' then '00000000-0000-4000-8000-000000000403'::uuid
 else '00000000-0000-4000-8000-000000000404'::uuid end;
insert into storage.buckets(id,name,public) values ('another-bucket','another-bucket',false);
insert into storage.objects(bucket_id,name) values ('staycut-deliverables','private.mp4'),('another-bucket','unrelated.mp4');

select test.ok(staycut_private.contract_today() = (statement_timestamp() at time zone 'Asia/Seoul')::date,'contract date uses Seoul server time');
select test.ok((select not public from storage.buckets where id='staycut-deliverables'),'delivery bucket is private');
select test.ok(not has_function_privilege('anon','public.authorize_asset_download(uuid,text,text)','EXECUTE'),'anonymous cannot execute download authorization');
select test.ok(not has_function_privilege('service_role','public.authorize_asset_download(uuid,text,text)','EXECUTE'),'service signer cannot substitute for user RPC');
select test.ok(not has_function_privilege('authenticated','staycut_private.assert_scope(public.assets,text,text)','EXECUTE'),'private internal helper not callable');
select test.throws($q$update public.assets set latest_version_id='00000000-0000-4000-8000-000000000403' where id='00000000-0000-4000-8000-000000000301'$q$,'23503','latest version must belong to exact asset and tenant');

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000101',true);
set local role authenticated;
select test.ok((select count(*)=1 from public.tenants),'RLS hides other tenant');
select test.ok((select count(*)=1 from public.tenant_members),'members can read only own membership');
select test.ok((select count(*)=2 from public.assets),'member reads own accessible assets');
select test.ok((select count(*)=3 from public.asset_versions),'RLS hides other tenant versions');
select test.ok((select count(*)=0 from public.assets where tenant_id='00000000-0000-4000-8000-000000000002'),'known foreign tenant UUID does not bypass RLS');
select test.throws($q$update public.assets set final_delivery_paid=true$q$,'42501','client cannot mark payment paid');
select test.throws($q$update public.assets set rights_status='valid',assigned_approver_id='00000000-0000-4000-8000-000000000102'$q$,'42501','client cannot change rights or assigned approver');
select test.throws($q$insert into public.tenants(name) values ('intruder')$q$,'42501','client cannot provision tenants');
select test.throws($q$insert into public.version_approvals(version_id) values ('00000000-0000-4000-8000-000000000402')$q$,'42501','client cannot forge approval history');
select test.throws($q$delete from public.tenant_members$q$,'42501','client cannot edit memberships');
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000403','instagram','organic',true)$q$,'42501','cross-tenant approval denied');
select test.throws($q$select public.authorize_asset_download('00000000-0000-4000-8000-000000000403','instagram','organic')$q$,'42501','cross-tenant download denied');
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000401','instagram','organic',true)$q$,'55000','stale version approval denied');
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000402','instagram','organic',false)$q$,'22023','unchecked confirmation denied');
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000402','instagram','organic',null)$q$,'22023','null confirmation denied');
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000402','instagram','organic',true,'Fix caption')$q$,'22023','unsent feedback denies approval');
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000402',null,'organic',true)$q$,'22023','null scope denied');
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000402','youtube','organic',true)$q$,'55000','unlicensed channel denied');
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000402','instagram','advertising',true)$q$,'55000','unlicensed purpose denied');
select test.ok((select count(*)=0 from public.version_approvals),'failed approval attempts leave no history');
select test.ok((select count(*)=0 from storage.objects where bucket_id='staycut-deliverables'),'broad existing storage policy cannot expose delivery objects');
select test.ok((select count(*)=1 from storage.objects where bucket_id='another-bucket'),'restrictive storage policy leaves unrelated buckets alone');
select test.ok((select count(*)=0 from storage.buckets where id='staycut-deliverables'),'browser cannot access private bucket administration');
with changed as (update storage.buckets set public=true where id='staycut-deliverables' returning id)
 select test.ok((select count(*)=0 from changed),'browser cannot make delivery bucket public');
select test.throws($q$insert into storage.objects(bucket_id,name) values ('staycut-deliverables','client-upload.mp4')$q$,'42501','browser upload to delivery bucket denied');

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000102',true);
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000402','instagram','organic',true)$q$,'42501','ordinary member cannot act as assigned approver');
select test.throws($q$select public.request_asset_revision('00000000-0000-4000-8000-000000000404','Fix caption')$q$,'42501','ordinary member cannot submit assigned review');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000103',true);
select test.ok((select count(*)=0 from public.assets),'inactive membership hides assets');
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000402','instagram','organic',true)$q$,'42501','inactive approver denied');
select set_config('request.jwt.claim.sub','',true);
select test.ok((select count(*)=0 from public.tenants),'authenticated role with no actor sees no tenant');
select test.throws($q$select public.authorize_asset_download('00000000-0000-4000-8000-000000000402','instagram','organic')$q$,'42501','missing actor cannot authorize download');
reset role;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000101',true);
update public.assets set access_allowed=false where id='00000000-0000-4000-8000-000000000301';
set local role authenticated;
select test.ok((select count(*)=0 from public.asset_versions where asset_id='00000000-0000-4000-8000-000000000301'),'revoked asset access hides versions');
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000402','instagram','organic',true)$q$,'42501','revoked asset access denies approval');
reset role;
update public.assets set access_allowed=true,access_end_date=current_date-2 where id='00000000-0000-4000-8000-000000000301';
set local role authenticated;
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000402','instagram','organic',true)$q$,'42501','expired asset access denies approval');
reset role;
update public.assets set access_end_date=current_date+30,rights_end_date=current_date-2 where id='00000000-0000-4000-8000-000000000301';
set local role authenticated;
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000402','instagram','organic',true)$q$,'55000','expired usage rights deny approval');
reset role;
update public.assets set rights_end_date=current_date+30,rights_start_date=current_date+2 where id='00000000-0000-4000-8000-000000000301';
set local role authenticated;
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000402','instagram','organic',true)$q$,'55000','future rights start denies approval');
reset role;
update public.assets set rights_start_date=current_date-30,rights_status='pending' where id='00000000-0000-4000-8000-000000000301';
set local role authenticated;
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000402','instagram','organic',true)$q$,'55000','unconfirmed rights deny approval');
reset role;
update public.assets set rights_status='valid' where id='00000000-0000-4000-8000-000000000301';
update public.asset_versions set preview_available=false where id='00000000-0000-4000-8000-000000000402';
set local role authenticated;
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000402','instagram','organic',true)$q$,'55000','missing preview denies approval');
reset role;
update public.asset_versions set preview_available=true where id='00000000-0000-4000-8000-000000000402';

set local role authenticated;
select test.ok(public.approve_asset_version('00000000-0000-4000-8000-000000000402','instagram','organic',true)->>'version_id'='00000000-0000-4000-8000-000000000402','valid assigned approval succeeds before payment');
select test.ok((select count(*)=1 from public.version_approvals),'exactly one immutable approval created');
select test.ok((select review_status='approved' from public.asset_versions where id='00000000-0000-4000-8000-000000000402'),'approval and review state change together');
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000402','instagram','organic',true)$q$,'55000','duplicate approval denied');
select test.throws($q$select public.authorize_asset_download('00000000-0000-4000-8000-000000000402','instagram','organic')$q$,'55000','approval does not bypass payment');
select test.throws($q$select public.authorize_asset_download('00000000-0000-4000-8000-000000000401','instagram','organic')$q$,'55000','approval is not inherited by an old version');
reset role;
select test.throws($q$update public.version_approvals set purpose='advertising'$q$,'55000','approval history immutable even for trusted writer');
select test.throws($q$delete from public.version_approvals$q$,'55000','approval history cannot be deleted');
select test.throws($q$truncate public.version_approvals$q$,'55000','approval history cannot be truncated');
select test.throws($q$update public.asset_versions set content_sha256=repeat('b',64) where id='00000000-0000-4000-8000-000000000402'$q$,'55000','approved file content cannot be replaced under same version');
select test.throws($q$update public.asset_versions set object_path=replace(object_path,'delivery.mp4','replacement.mp4') where id='00000000-0000-4000-8000-000000000402'$q$,'55000','approved storage path immutable');
update public.assets set final_delivery_paid=true where id='00000000-0000-4000-8000-000000000301';
set local role authenticated;
select test.ok((select bucket_id='staycut-deliverables' and object_path like '%/00000000-0000-4000-8000-000000000402/delivery.mp4' from public.authorize_asset_download('00000000-0000-4000-8000-000000000402','instagram','organic')),'paid exact approved version returns only private storage location');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000102',true);
select test.ok((select count(*)=1 from public.authorize_asset_download('00000000-0000-4000-8000-000000000402','instagram','organic')),'active ordinary member may download approved paid file');
reset role;
update public.tenant_members set access_end_date=current_date-2 where user_id='00000000-0000-4000-8000-000000000102';
set local role authenticated;
select test.ok((select count(*)=0 from public.tenants),'expired membership hides tenant');
select test.throws($q$select public.authorize_asset_download('00000000-0000-4000-8000-000000000402','instagram','organic')$q$,'42501','expired membership denies download');
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000101',true);
update public.assets set rights_status='expired' where id='00000000-0000-4000-8000-000000000301';
set local role authenticated;
select test.ok((select count(*)=1 from public.version_approvals),'rights expiry preserves approval history');
select test.throws($q$select public.authorize_asset_download('00000000-0000-4000-8000-000000000402','instagram','organic')$q$,'55000','rights expiry blocks previously approved download');
reset role;
update public.assets set rights_status='valid' where id='00000000-0000-4000-8000-000000000301';
update public.asset_versions set delivery_available=false where id='00000000-0000-4000-8000-000000000402';
set local role authenticated;
select test.throws($q$select public.authorize_asset_download('00000000-0000-4000-8000-000000000402','instagram','organic')$q$,'55000','unavailable delivery file blocks signing');
reset role;

set local role authenticated;
select test.throws($q$select public.request_asset_revision('00000000-0000-4000-8000-000000000404','   ')$q$,'22023','blank revision rejected');
select test.throws($q$select public.request_asset_revision('00000000-0000-4000-8000-000000000404',E'\t\n\r')$q$,'22023','whitespace-only revision rejected');
select test.ok(public.request_asset_revision('00000000-0000-4000-8000-000000000404','Please fix caption')->>'version_id'='00000000-0000-4000-8000-000000000404','valid revision request succeeds');
select test.ok((select review_status='revision_requested' from public.asset_versions where id='00000000-0000-4000-8000-000000000404'),'revision and review state change together');
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000404','instagram','organic',true)$q$,'55000','revision request blocks approval');
reset role;
insert into public.asset_versions(id,asset_id,tenant_id,version_number,preview_available,delivery_available,object_path,content_sha256)
 select '00000000-0000-4000-8000-000000000405',id,tenant_id,2,true,true,
 tenant_id::text||'/'||id::text||'/00000000-0000-4000-8000-000000000405/delivery.mp4',repeat('b',64)
 from public.assets where id='00000000-0000-4000-8000-000000000303';
update public.assets set latest_version_id='00000000-0000-4000-8000-000000000405' where id='00000000-0000-4000-8000-000000000303';
set local role authenticated;
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000405','instagram','organic',true)$q$,'55000','new version still requires producer to resolve open revision');
reset role;
update public.revision_requests set resolved_at=clock_timestamp() where version_id='00000000-0000-4000-8000-000000000404';
set local role authenticated;
select test.ok(public.approve_asset_version('00000000-0000-4000-8000-000000000405','instagram','organic',true)->>'version_id'='00000000-0000-4000-8000-000000000405','new version can be approved after producer resolves revision');
reset role;

-- A producer can publish a new latest version without erasing the old approval.
update public.assets set latest_version_id='00000000-0000-4000-8000-000000000401' where id='00000000-0000-4000-8000-000000000301';
set local role authenticated;
select test.ok((select count(*)=2 from public.version_approvals),'changing latest version preserves immutable approval records');
select test.throws($q$select public.authorize_asset_download('00000000-0000-4000-8000-000000000402','instagram','organic')$q$,'55000','superseded approved version cannot be signed');
reset role;

set local role anon;
select test.throws($q$select * from public.assets$q$,'42501','anonymous cannot read portal data');
select test.throws($q$select public.approve_asset_version('00000000-0000-4000-8000-000000000402','instagram','organic',true)$q$,'42501','anonymous cannot approve');
select test.throws($q$select public.authorize_asset_download('00000000-0000-4000-8000-000000000402','instagram','organic')$q$,'42501','anonymous cannot authorize download');
select test.ok((select count(*)=0 from storage.objects where bucket_id='staycut-deliverables'),'anonymous cannot read private objects despite broad policy');
reset role;
set local role service_role;
select test.ok((select count(*)=1 from storage.objects where bucket_id='staycut-deliverables'),'trusted service signer retains storage access');
select test.throws($q$insert into public.version_approvals(version_id) values ('00000000-0000-4000-8000-000000000401')$q$,'42501','service role cannot forge user approval through direct insert');
reset role;

rollback;
\echo 'All portal database regression assertions passed.'
