-- Disposable PostgreSQL regression data only; never run against a real project.
\set ON_ERROR_STOP on
begin;

insert into auth.users(id,email,email_confirmed_at) values
 ('00000000-0000-4000-8000-000000001111','operator-a@example.invalid',clock_timestamp()),
 ('00000000-0000-4000-8000-000000001112','operator-b@example.invalid',clock_timestamp()),
 ('00000000-0000-4000-8000-000000001113','inactive-operator@example.invalid',clock_timestamp()),
 ('00000000-0000-4000-8000-000000001121','customer-a@example.invalid',clock_timestamp()),
 ('00000000-0000-4000-8000-000000001122','customer-b@example.invalid',clock_timestamp()),
 ('00000000-0000-4000-8000-000000001123','new-customer@example.invalid',clock_timestamp()),
 ('00000000-0000-4000-8000-000000001124','unverified@example.invalid',null);
insert into public.portal_operators(user_id,active) values
 ('00000000-0000-4000-8000-000000001111',true),
 ('00000000-0000-4000-8000-000000001112',true),
 ('00000000-0000-4000-8000-000000001113',false);
insert into public.tenants(id,name) values
 ('00000000-0000-4000-8000-000000001101','Operator fixture A'),
 ('00000000-0000-4000-8000-000000001102','Operator fixture B');
insert into public.tenant_members(tenant_id,user_id,role,active,access_allowed,access_start_date,access_end_date) values
 ('00000000-0000-4000-8000-000000001101','00000000-0000-4000-8000-000000001121','owner',true,true,current_date-30,current_date+30),
 ('00000000-0000-4000-8000-000000001102','00000000-0000-4000-8000-000000001122','owner',true,true,current_date-30,current_date+30);

-- Test-only state retains the real RPC manifests across user/service role changes.
create temporary table operator_test_state(key text primary key,value jsonb not null) on commit drop;
grant select,insert,update on operator_test_state to authenticated,service_role;
insert into operator_test_state(key,value) values ('new',jsonb_build_object(
 'tenantId','00000000-0000-4000-8000-000000001101',
 'assetId',null,
 'title','Synthetic review clip',
 'assignedApproverId','00000000-0000-4000-8000-000000001121',
 'changeSummary','First synthetic version',
 'terms',jsonb_build_object(
   'accessAllowed',true,'accessStartDate',current_date-30,'accessEndDate',current_date+30,
   'rightsStartDate',current_date-30,'rightsEndDate',current_date+30,
   'allowedChannels',jsonb_build_array('instagram'),'allowedPurposes',jsonb_build_array('organic')),
 'delivery',jsonb_build_object('sha256',repeat('a',64),'bytes',32,'mimeType','video/mp4'),
 'preview',jsonb_build_object('sha256',repeat('b',64),'bytes',16,'mimeType','video/webm')));

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000001121',true);
set local role authenticated;
select test.throws($q$select public.operator_context()$q$,'42501','customer owner is not implicitly a portal operator');
select test.throws($q$select public.operator_prepare_upload((select value from operator_test_state where key='new'))$q$,'42501','customer owner cannot prepare media');
select test.throws($q$select public.operator_create_tenant('Forbidden','new-customer@example.invalid',current_date,current_date+10)$q$,'42501','customer owner cannot provision another customer');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000001113',true);
select test.throws($q$select public.operator_context()$q$,'42501','inactive operator is denied');
reset role;
set local role anon;
select test.throws($q$select public.operator_context()$q$,'42501','anonymous operator access is denied');
reset role;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000001111',true);
set local role authenticated;
select test.ok(public.operator_context()->'operator'->>'user_id'='00000000-0000-4000-8000-000000001111'
 and jsonb_array_length(public.operator_context()->'tenants')=2,'explicit operator sees cross-tenant administration context');
select test.throws($q$insert into public.portal_operators(user_id,active) values ('00000000-0000-4000-8000-000000001121',true)$q$,'42501','operator browser cannot grant operator privileges directly');
select test.throws($q$update public.assets set final_delivery_paid=true$q$,'42501','operator browser still cannot directly write customer assets');
select test.throws($q$select public.operator_create_tenant('Unverified','unverified@example.invalid',current_date,current_date+10)$q$,'42501','provisioning requires a verified existing customer Auth account');
insert into operator_test_state(key,value)
 select 'tenant',public.operator_create_tenant('Created by operator','new-customer@example.invalid',current_date-1,current_date+30);
select test.ok((select value->>'customerId'='00000000-0000-4000-8000-000000001123' and (value->>'tenantId')::uuid is not null
 from operator_test_state where key='tenant'),'operator provisions the explicitly selected existing customer');

select test.throws($q$select public.operator_prepare_upload(jsonb_set((select value from operator_test_state where key='new'),'{assignedApproverId}','"00000000-0000-4000-8000-000000001122"'))$q$,'42501','foreign-tenant assigned approver is rejected');
select test.throws($q$select public.operator_prepare_upload((select value from operator_test_state where key='new')||'{"objectPath":"attacker.mp4"}'::jsonb)$q$,'22023','unknown upload fields cannot supply a storage path');
select test.throws($q$select public.operator_prepare_upload((select value from operator_test_state where key='new')||'{"expectedRevisionId":null}'::jsonb)$q$,'22023','new asset upload cannot claim an existing revision context');
select test.throws($q$select public.operator_prepare_upload((select value from operator_test_state where key='new')||'{"expectedLatestVersionId":null}'::jsonb)$q$,'22023','new asset upload cannot claim an existing latest-version context');
select test.throws($q$select public.operator_prepare_upload(jsonb_set((select value from operator_test_state where key='new'),'{preview,mimeType}','"text/html"'))$q$,'22023','non-video upload MIME type is rejected');
select test.throws($q$select public.operator_prepare_upload(jsonb_set((select value from operator_test_state where key='new'),'{delivery,sha256}','"invalid-hash"'))$q$,'22023','invalid content hash is rejected');
select test.throws($q$select public.operator_prepare_upload(jsonb_set((select value from operator_test_state where key='new'),'{delivery,bytes}','0'))$q$,'22023','empty media is rejected');
select test.throws($q$select public.operator_prepare_upload(jsonb_set((select value from operator_test_state where key='new'),'{preview,bytes}','52428801'))$q$,'22023','media above the 50 MiB bound is rejected');

insert into operator_test_state(key,value) select 'first',public.operator_prepare_upload(value) from operator_test_state where key='new';
select test.ok((select public.operator_upload_manifest((value->>'sessionId')::uuid)->>'versionId'=value->>'versionId'
 from operator_test_state where key='first'),'preparing operator can read the server-generated upload manifest');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000001112',true);
select test.throws($q$select public.operator_upload_manifest((select (value->>'sessionId')::uuid from operator_test_state where key='first'))$q$,'42501','another active operator cannot claim the upload session');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000001111',true);
select test.throws($q$select public.operator_commit_upload((select (value->>'sessionId')::uuid from operator_test_state where key='first'),'00000000-0000-4000-8000-000000001111',repeat('a',64),32,repeat('b',64),16)$q$,'42501','operator browser cannot finalize an upload');
reset role;
select test.ok(not exists(select 1 from public.assets where id=(select (value->>'assetId')::uuid from operator_test_state where key='first'))
 and not exists(select 1 from public.asset_versions where id=(select (value->>'versionId')::uuid from operator_test_state where key='first')),
 'prepared media is invisible before verified commit');

set local role service_role;
select test.throws($q$select public.operator_commit_upload((select (value->>'sessionId')::uuid from operator_test_state where key='first'),'00000000-0000-4000-8000-000000001111',repeat('c',64),32,repeat('b',64),16)$q$,'55000','service commit requires matching server-attested content');
select public.operator_commit_upload((value->>'sessionId')::uuid,'00000000-0000-4000-8000-000000001111',repeat('a',64),32,repeat('b',64),16)
 from operator_test_state where key='first';
reset role;
select test.ok((select a.latest_version_id=(s.value->>'versionId')::uuid and a.rights_status='pending' and not a.final_delivery_paid
 and v.preview_available and v.delivery_available and v.object_path=s.value->'delivery'->>'finalPath'
 and v.preview_object_path=s.value->'preview'->>'finalPath' and v.object_path<>v.preview_object_path
 from public.assets a join public.asset_versions v on v.id=a.latest_version_id cross join operator_test_state s
 where s.key='first' and a.id=(s.value->>'assetId')::uuid),
 'verified commit publishes distinct immutable media paths with pending rights and unpaid defaults');

-- Make the first version approvable through the actual operator terms RPC.
set local role authenticated;
select public.operator_update_asset(jsonb_build_object('assetId',f.value->>'assetId',
 'terms',(n.value->'terms')||'{"rightsStatus":"valid","finalDeliveryPaid":true}'::jsonb))
 from operator_test_state f cross join operator_test_state n where f.key='first' and n.key='new';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000001121',true);
select public.approve_asset_version((value->>'versionId')::uuid,'instagram','organic',true) from operator_test_state where key='first';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000001111',true);
insert into operator_test_state(key,value)
 select 'next',(n.value-'terms'-'title'-'assignedApproverId')||jsonb_build_object('assetId',f.value->>'assetId','changeSummary','Second synthetic version',
   'expectedLatestVersionId',f.value->>'versionId','expectedRevisionId',null)
 from operator_test_state n cross join operator_test_state f where n.key='new' and f.key='first';
select test.throws($q$select public.operator_prepare_upload((select value-'expectedRevisionId' from operator_test_state where key='next'))$q$,'22023','existing asset upload requires explicit observed revision context');
select test.throws($q$select public.operator_prepare_upload((select value-'expectedLatestVersionId' from operator_test_state where key='next'))$q$,'22023','existing asset upload requires explicit observed latest-version context');
select test.throws($q$select public.operator_prepare_upload((select value from operator_test_state where key='next')||'{"terms":{}}'::jsonb)$q$,'22023','new-version upload cannot silently change asset contract terms');
insert into operator_test_state(key,value) select 'second',public.operator_prepare_upload(value) from operator_test_state where key='next';
insert into operator_test_state(key,value) select 'parallel',public.operator_prepare_upload(value) from operator_test_state where key='next';
reset role;
set local role service_role;
select public.operator_commit_upload((value->>'sessionId')::uuid,'00000000-0000-4000-8000-000000001111',repeat('a',64),32,repeat('b',64),16)
 from operator_test_state where key='second';
select test.throws($q$select public.operator_commit_upload((select (value->>'sessionId')::uuid from operator_test_state where key='parallel'),'00000000-0000-4000-8000-000000001111',repeat('a',64),32,repeat('b',64),16)$q$,'55000','stale parallel preparation cannot replace a newer latest version');
-- Replaying the first commit after a later version exists must be a true no-op.
select public.operator_commit_upload((value->>'sessionId')::uuid,'00000000-0000-4000-8000-000000001111',repeat('a',64),32,repeat('b',64),16)
 from operator_test_state where key='first';
reset role;
select test.ok((select a.latest_version_id=(s.value->>'versionId')::uuid
 and (select count(*) from public.asset_versions v where v.asset_id=a.id)=2
 and exists(select 1 from public.version_approvals p where p.asset_id=a.id and p.version_id=(f.value->>'versionId')::uuid)
 from public.assets a cross join operator_test_state s cross join operator_test_state f
 where s.key='second' and f.key='first' and a.id=(s.value->>'assetId')::uuid),
 'new version preserves original approval and old commit replay cannot roll latest back');
select test.throws($q$update public.asset_versions set content_sha256=repeat('d',64) where id=(select (value->>'versionId')::uuid from operator_test_state where key='first')$q$,'55000','approved original content remains immutable after upload of a new version');

-- Feedback arriving after prepare cannot be accidentally resolved by commit.
set local role authenticated;
select test.throws($q$select public.operator_prepare_upload((select value from operator_test_state where key='next'))$q$,'55000','latest version changed after observed context prevents stale preparation');
insert into operator_test_state(key,value) values ('observed_context',public.operator_context());
select test.ok(exists(select 1 from operator_test_state c cross join operator_test_state s,
 jsonb_array_elements(c.value->'assets') a
 where c.key='observed_context' and s.key='second' and a->>'id'=s.value->>'assetId'
 and a->'latest_version'->>'id'=s.value->>'versionId' and a->'open_revision'='null'::jsonb),
 'operator context exposes the exact latest version and observed empty revision context');
update operator_test_state n set value=n.value||(
 select jsonb_build_object('expectedLatestVersionId',a->'latest_version'->>'id','expectedRevisionId',a->'open_revision'->>'id')
 from operator_test_state c,jsonb_array_elements(c.value->'assets') a
 where c.key='observed_context' and a->>'id'=n.value->>'assetId') where n.key='next';
insert into operator_test_state(key,value) select 'before_feedback',public.operator_prepare_upload(value) from operator_test_state where key='next';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000001121',true);
select public.request_asset_revision((value->>'versionId')::uuid,'Synthetic feedback after prepare') from operator_test_state where key='second';
reset role;
set local role service_role;
select test.throws($q$select public.operator_commit_upload((select (value->>'sessionId')::uuid from operator_test_state where key='before_feedback'),'00000000-0000-4000-8000-000000001111',repeat('a',64),32,repeat('b',64),16)$q$,'55000','feedback arriving after preparation prevents commit');
reset role;
select test.ok((select a.latest_version_id=(s.value->>'versionId')::uuid
 and (select count(*) from public.revision_requests r where r.asset_id=a.id and r.resolved_at is null)=1
 from public.assets a cross join operator_test_state s where s.key='second' and a.id=(s.value->>'assetId')::uuid),
 'failed commit leaves both the latest version and unexpected feedback unchanged');

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000001111',true);
set local role authenticated;
select test.throws($q$select public.operator_prepare_upload((select value from operator_test_state where key='next'))$q$,'55000','feedback arriving after observed context prevents stale preparation');
update operator_test_state n set value=n.value||(
 select jsonb_build_object('expectedLatestVersionId',a->'latest_version'->>'id','expectedRevisionId',a->'open_revision'->>'id')
 from jsonb_array_elements(public.operator_context()->'assets') a
 where a->>'id'=n.value->>'assetId') where n.key='next';
insert into operator_test_state(key,value) select 'revision',public.operator_prepare_upload(value) from operator_test_state where key='next';
insert into operator_test_state(key,value) select 'expired',public.operator_prepare_upload(value) from operator_test_state where key='next';
reset role;
update public.operator_upload_sessions set expires_at=clock_timestamp()-interval '1 second'
 where id=(select (value->>'sessionId')::uuid from operator_test_state where key='expired');
set local role service_role;
select test.throws($q$select public.operator_commit_upload((select (value->>'sessionId')::uuid from operator_test_state where key='expired'),'00000000-0000-4000-8000-000000001111',repeat('a',64),32,repeat('b',64),16)$q$,'55000','expired upload session cannot be committed');
select public.operator_commit_upload((value->>'sessionId')::uuid,'00000000-0000-4000-8000-000000001111',repeat('a',64),32,repeat('b',64),16)
 from operator_test_state where key='revision';
reset role;
select test.ok((select a.latest_version_id=(s.value->>'versionId')::uuid
 and exists(select 1 from public.revision_requests r where r.asset_id=a.id and r.resolved_at is not null)
 and not exists(select 1 from public.revision_requests r where r.asset_id=a.id and r.resolved_at is null)
 from public.assets a cross join operator_test_state s where s.key='revision' and a.id=(s.value->>'assetId')::uuid),
 'fresh upload commit resolves exactly the captured open revision');

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000001121',true);
set local role authenticated;
select public.request_asset_revision((value->>'versionId')::uuid,'Synthetic feedback on third version') from operator_test_state where key='revision';
reset role;
set local role service_role;
select public.operator_commit_upload((value->>'sessionId')::uuid,'00000000-0000-4000-8000-000000001111',repeat('a',64),32,repeat('b',64),16)
 from operator_test_state where key='revision';
reset role;
select test.ok((select count(*)=1 from public.revision_requests r where r.resolved_at is null
 and r.asset_id=(select (value->>'assetId')::uuid from operator_test_state where key='revision')),
 'idempotent commit replay never resolves feedback created after that commit');
select test.ok(exists(select 1 from public.operator_action_log where actor_id='00000000-0000-4000-8000-000000001111'),
 'operator RPC changes produce actor-attributed audit history');
select test.throws($q$update public.operator_action_log set details='{}'::jsonb$q$,'55000','operator audit history cannot be rewritten');
select test.throws($q$delete from public.operator_action_log$q$,'55000','operator audit history cannot be deleted');
select test.throws($q$truncate public.operator_action_log$q$,'55000','operator audit history cannot be truncated');

rollback;
\echo 'All operator database regression assertions passed.'
