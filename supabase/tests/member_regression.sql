-- Disposable PostgreSQL regression data only; never run on a real project.
\set ON_ERROR_STOP on
begin;

insert into auth.users(id,email,email_confirmed_at) values
 ('00000000-0000-4000-8000-000000002111','members-operator@example.invalid',clock_timestamp()),
 ('00000000-0000-4000-8000-000000002113','members-inactive@example.invalid',clock_timestamp()),
 ('00000000-0000-4000-8000-000000002121','members-owner-a@example.invalid',clock_timestamp()),
 ('00000000-0000-4000-8000-000000002122','members-owner-b@example.invalid',clock_timestamp()),
 ('00000000-0000-4000-8000-000000002123','members-new@example.invalid',clock_timestamp()),
 ('00000000-0000-4000-8000-000000002124','members-unverified@example.invalid',null),
 ('00000000-0000-4000-8000-000000002125','members-duplicate@example.invalid',clock_timestamp()),
 ('00000000-0000-4000-8000-000000002126','MEMBERS-DUPLICATE@example.invalid',clock_timestamp()),
 ('00000000-0000-4000-8000-000000002127','members-expired@example.invalid',clock_timestamp()),
 ('00000000-0000-4000-8000-000000002128','members-future@example.invalid',clock_timestamp());
insert into public.portal_operators(user_id,active) values
 ('00000000-0000-4000-8000-000000002111',true),('00000000-0000-4000-8000-000000002113',false);
insert into public.tenants(id,name) values
 ('00000000-0000-4000-8000-000000002101','Member fixture A'),
 ('00000000-0000-4000-8000-000000002102','Member fixture B');
insert into public.tenant_members(tenant_id,user_id,role,active,access_allowed,access_start_date,access_end_date) values
 ('00000000-0000-4000-8000-000000002101','00000000-0000-4000-8000-000000002121','owner',true,true,staycut_private.contract_today()-30,staycut_private.contract_today()+30),
 ('00000000-0000-4000-8000-000000002102','00000000-0000-4000-8000-000000002122','owner',true,true,staycut_private.contract_today()-30,staycut_private.contract_today()+30),
 ('00000000-0000-4000-8000-000000002101','00000000-0000-4000-8000-000000002124','member',true,true,staycut_private.contract_today()-30,staycut_private.contract_today()+30),
 ('00000000-0000-4000-8000-000000002101','00000000-0000-4000-8000-000000002127','member',true,true,staycut_private.contract_today()-30,staycut_private.contract_today()-1),
 ('00000000-0000-4000-8000-000000002101','00000000-0000-4000-8000-000000002128','member',true,true,staycut_private.contract_today()+1,staycut_private.contract_today()+30);

create temporary table member_test_state(key text primary key,value jsonb not null) on commit drop;
grant select,insert,update on member_test_state to authenticated,service_role;
insert into member_test_state(key,value) values
 ('add',jsonb_build_object('tenantId','00000000-0000-4000-8000-000000002101',
   'customerEmail','MEMBERS-NEW@example.invalid','accessAllowed',true,
   'accessStartDate',staycut_private.contract_today()-30,'accessEndDate',staycut_private.contract_today()+30)),
 ('update',jsonb_build_object('tenantId','00000000-0000-4000-8000-000000002101',
   'userId','00000000-0000-4000-8000-000000002123','expectedRevision',1,'active',false,'accessAllowed',false,
   'accessStartDate',staycut_private.contract_today()-30,'accessEndDate',staycut_private.contract_today()+30)),
 ('assign',jsonb_build_object('assetId','00000000-0000-4000-8000-000000002201',
   'assignedApproverId','00000000-0000-4000-8000-000000002123',
   'expectedAssignedApproverId','00000000-0000-4000-8000-000000002121',
   'expectedLatestVersionId','00000000-0000-4000-8000-000000002302'));

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000002121',true);
set local role authenticated;
select test.throws($q$select public.operator_add_member((select value from member_test_state where key='add'))$q$,'42501','customer owner cannot add a member');
select test.throws($q$select public.operator_update_member((select value from member_test_state where key='update'))$q$,'42501','customer owner cannot update membership access');
select test.throws($q$select public.operator_assign_approver((select value from member_test_state where key='assign'))$q$,'42501','customer owner cannot reassign an approver');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000002113',true);
select test.throws($q$select public.operator_add_member((select value from member_test_state where key='add'))$q$,'42501','inactive operator cannot manage membership');
reset role;
set local role anon;
select test.throws($q$select public.operator_add_member('{}')$q$,'42501','anonymous role cannot invoke member management');
reset role;
set local role service_role;
select test.throws($q$select public.operator_update_member('{}')$q$,'42501','service key alone cannot invoke user membership management');
reset role;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000002111',true);
set local role authenticated;
select test.throws($q$select public.operator_add_member((select value from member_test_state where key='add')||'{"role":"owner"}')$q$,'22023','add member cannot grant customer owner role');
select test.throws($q$select public.operator_add_member((select value from member_test_state where key='add')||'{"operator":true}')$q$,'22023','add member cannot grant portal operator role');
select test.throws($q$select public.operator_add_member((select value from member_test_state where key='add')||'{"customerEmail":"absent@example.invalid"}')$q$,'42501','missing Auth account is not created by membership addition');
select test.throws($q$select public.operator_add_member((select value from member_test_state where key='add')||'{"customerEmail":"members-unverified@example.invalid"}')$q$,'42501','unverified Auth account cannot gain new membership');
select test.throws($q$select public.operator_add_member((select value from member_test_state where key='add')||'{"customerEmail":"members-duplicate@example.invalid"}')$q$,'42501','ambiguous case-normalized Auth email is rejected');
select test.throws($q$select public.operator_add_member((select value from member_test_state where key='add')||'{"tenantId":"00000000-0000-4000-8000-000000009999"}')$q$,'42501','membership cannot target a missing tenant');
select test.throws($q$select public.operator_add_member((select value from member_test_state where key='add')||'{"accessAllowed":"true"}')$q$,'22023','membership permission requires a JSON boolean');
select test.throws($q$select public.operator_add_member((select value from member_test_state where key='add')||'{"accessEndDate":"2026-02-30"}')$q$,'22023','membership rejects impossible calendar date');
select test.throws($q$select public.operator_add_member((select value from member_test_state where key='add')||jsonb_build_object('accessEndDate',staycut_private.contract_today()-31))$q$,'22023','membership rejects reversed access interval');
select test.throws($q$select public.operator_add_member((select value from member_test_state where key='add')||'{"customerEmail":"members-owner-a@example.invalid"}')$q$,'55000','add does not silently replace an existing owner membership');
insert into member_test_state(key,value) select 'added',public.operator_add_member(value) from member_test_state where key='add';
insert into member_test_state(key,value) select 'replayed',public.operator_add_member(value) from member_test_state where key='add';
select test.ok((select value='{"tenantId":"00000000-0000-4000-8000-000000002101","userId":"00000000-0000-4000-8000-000000002123","revision":1}'::jsonb from member_test_state where key='added')
 and (select a.value=b.value from member_test_state a cross join member_test_state b where a.key='added' and b.key='replayed'),
 'identical member addition replay returns original membership revision');
select test.ok(exists(select 1 from jsonb_array_elements(public.operator_context()->'members') m
 where m->>'tenant_id'='00000000-0000-4000-8000-000000002101' and m->>'user_id'='00000000-0000-4000-8000-000000002123'
 and m->>'revision'='1' and m->>'role'='member'), 'operator context includes the member role and revision');
select test.throws($q$select public.operator_add_member((select value from member_test_state where key='add')||jsonb_build_object('accessEndDate',staycut_private.contract_today()+60))$q$,'55000','add replay cannot silently extend existing access');
select test.throws($q$select public.operator_update_member((select value from member_test_state where key='update')||'{"role":"owner"}')$q$,'22023','membership update cannot change customer role');
select test.throws($q$select public.operator_update_member((select value from member_test_state where key='update')||'{"expectedRevision":1.5}')$q$,'22023','membership revision must be a positive integer');
select test.throws($q$select public.operator_update_member((select value from member_test_state where key='update')||'{"expectedRevision":2147483648}')$q$,'22023','membership revision cannot overflow PostgreSQL integer');
select test.throws($q$select public.operator_update_member((select value from member_test_state where key='update')||'{"tenantId":"00000000-0000-4000-8000-000000002102"}')$q$,'42501','update never attaches member to a different tenant');
insert into member_test_state(key,value) select 'revoked',public.operator_update_member(value) from member_test_state where key='update';
select test.ok((select value->>'revision'='2' from member_test_state where key='revoked'), 'explicit access revocation advances revision');
select test.throws($q$select public.operator_update_member((select value from member_test_state where key='update'))$q$,'55000','stale member editor cannot overwrite revocation');
select test.throws($q$select public.operator_add_member((select value from member_test_state where key='add'))$q$,'55000','add cannot silently reactivate a revoked membership');
select public.operator_update_member(value||'{"expectedRevision":2,"active":true,"accessAllowed":true}'::jsonb)
 from member_test_state where key='update';
reset role;
select test.ok((select role='member' and active and access_allowed and revision=3 from public.tenant_members
 where tenant_id='00000000-0000-4000-8000-000000002101' and user_id='00000000-0000-4000-8000-000000002123')
 and not exists(select 1 from public.portal_operators where user_id='00000000-0000-4000-8000-000000002123'),
 'explicit reactivation preserves ordinary role and grants no operator privileges');
select test.ok((select count(*)=1 from public.operator_action_log where action='member_added')
 and exists(select 1 from public.operator_action_log where action='member_updated'
 and actor_id='00000000-0000-4000-8000-000000002111' and details->'before'->>'revision'='1'
 and details->'after'->>'revision'='2' and details->'after'->>'active'='false'),
 'membership audit records actor and exact before/after state without duplicating replay');
update public.tenant_members set revision=999,access_end_date=access_end_date
 where tenant_id='00000000-0000-4000-8000-000000002101' and user_id='00000000-0000-4000-8000-000000002123';
select test.ok((select revision=4 from public.tenant_members where tenant_id='00000000-0000-4000-8000-000000002101'
 and user_id='00000000-0000-4000-8000-000000002123'), 'administrator updates also advance revision and cannot force an arbitrary revision');
set local role authenticated;
select test.throws($q$select public.operator_update_member((select value from member_test_state where key='update')||'{"expectedRevision":3}')$q$,'55000','administrator edit invalidates an earlier operator form');
select public.operator_update_member(value||'{"userId":"00000000-0000-4000-8000-000000002121","active":true,"accessAllowed":true}'::jsonb)
 from member_test_state where key='update';
reset role;
select test.ok((select role='owner' and revision=2 from public.tenant_members where tenant_id='00000000-0000-4000-8000-000000002101'
 and user_id='00000000-0000-4000-8000-000000002121'), 'owner access editing preserves the owner role');

-- Preserve real customer approval/revision history through reassignment.
insert into public.assets(id,tenant_id,title,assigned_approver_id,access_allowed,access_start_date,access_end_date,
 rights_status,rights_start_date,rights_end_date,allowed_channels,allowed_purposes,final_delivery_paid) values
 ('00000000-0000-4000-8000-000000002201','00000000-0000-4000-8000-000000002101','Synthetic assignment clip',
 '00000000-0000-4000-8000-000000002121',true,staycut_private.contract_today()-30,staycut_private.contract_today()+30,
 'valid',staycut_private.contract_today()-30,staycut_private.contract_today()+30,array['instagram'],array['organic'],true);
insert into public.asset_versions(id,asset_id,tenant_id,version_number,object_path,content_sha256,preview_available,
 preview_object_path,preview_content_sha256,delivery_available) values
 ('00000000-0000-4000-8000-000000002301','00000000-0000-4000-8000-000000002201','00000000-0000-4000-8000-000000002101',1,
 '00000000-0000-4000-8000-000000002101/00000000-0000-4000-8000-000000002201/00000000-0000-4000-8000-000000002301/delivery.mp4',repeat('a',64),true,
 '00000000-0000-4000-8000-000000002101/00000000-0000-4000-8000-000000002201/00000000-0000-4000-8000-000000002301/preview/review.webm',repeat('b',64),true);
update public.assets set latest_version_id='00000000-0000-4000-8000-000000002301' where id='00000000-0000-4000-8000-000000002201';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000002121',true);
set local role authenticated;
select public.approve_asset_version('00000000-0000-4000-8000-000000002301','instagram','organic',true);
reset role;
insert into public.asset_versions(id,asset_id,tenant_id,version_number,object_path,content_sha256,preview_available,
 preview_object_path,preview_content_sha256,delivery_available) values
 ('00000000-0000-4000-8000-000000002302','00000000-0000-4000-8000-000000002201','00000000-0000-4000-8000-000000002101',2,
 '00000000-0000-4000-8000-000000002101/00000000-0000-4000-8000-000000002201/00000000-0000-4000-8000-000000002302/delivery.mp4',repeat('c',64),true,
 '00000000-0000-4000-8000-000000002101/00000000-0000-4000-8000-000000002201/00000000-0000-4000-8000-000000002302/preview/review.webm',repeat('d',64),true);
update public.assets set latest_version_id='00000000-0000-4000-8000-000000002302' where id='00000000-0000-4000-8000-000000002201';
set local role authenticated;
select public.request_asset_revision('00000000-0000-4000-8000-000000002302','Synthetic feedback retained after assignment');
reset role;
insert into member_test_state(key,value) select 'asset_before',to_jsonb(a) from public.assets a where id='00000000-0000-4000-8000-000000002201';
insert into member_test_state(key,value) select 'revision_before',to_jsonb(r) from public.revision_requests r where asset_id='00000000-0000-4000-8000-000000002201';
insert into member_test_state(key,value) select 'upload',jsonb_build_object('tenantId',a.tenant_id,'assetId',a.id,
 'expectedLatestVersionId',a.latest_version_id,'expectedRevisionId',r.id,'changeSummary','Synthetic third version',
 'delivery',jsonb_build_object('sha256',repeat('e',64),'bytes',32,'mimeType','video/mp4'),
 'preview',jsonb_build_object('sha256',repeat('f',64),'bytes',16,'mimeType','video/webm'))
 from public.assets a join public.revision_requests r on r.asset_id=a.id where a.id='00000000-0000-4000-8000-000000002201';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000002111',true);
set local role authenticated;
insert into member_test_state(key,value) select 'prepared_old',public.operator_prepare_upload(value) from member_test_state where key='upload';
select test.throws($q$select public.operator_assign_approver((select value from member_test_state where key='assign')||'{"assignedApproverId":"00000000-0000-4000-8000-000000002122"}')$q$,'42501','approver must be a member of the asset tenant');
select test.throws($q$select public.operator_assign_approver((select value from member_test_state where key='assign')||'{"assignedApproverId":"00000000-0000-4000-8000-000000002124"}')$q$,'42501','unverified tenant member cannot become approver');
select test.throws($q$select public.operator_assign_approver((select value from member_test_state where key='assign')||'{"assignedApproverId":"00000000-0000-4000-8000-000000002127"}')$q$,'42501','expired tenant member cannot become approver');
select test.throws($q$select public.operator_assign_approver((select value from member_test_state where key='assign')||'{"assignedApproverId":"00000000-0000-4000-8000-000000002128"}')$q$,'42501','future access period is not currently eligible for approval');
select test.throws($q$select public.operator_assign_approver((select value from member_test_state where key='assign')||'{"expectedLatestVersionId":"00000000-0000-4000-8000-000000002301"}')$q$,'55000','reassignment rejects an outdated latest version');
select test.throws($q$select public.operator_assign_approver((select value from member_test_state where key='assign')||'{"expectedAssignedApproverId":null}')$q$,'55000','explicit empty observed approver cannot replace a nonempty assignment');
select test.throws($q$select public.operator_assign_approver((select value from member_test_state where key='assign')||'{"terms":{}}')$q$,'22023','reassignment cannot change asset contract terms');
select public.operator_assign_approver(value) from member_test_state where key='assign';
select test.throws($q$select public.operator_assign_approver((select value from member_test_state where key='assign'))$q$,'55000','a stale approver form cannot overwrite another assignment');
reset role;
select test.ok((select to_jsonb(a)-'assigned_approver_id'=b.value-'assigned_approver_id'
 and a.assigned_approver_id='00000000-0000-4000-8000-000000002123' from public.assets a cross join member_test_state b
 where a.id='00000000-0000-4000-8000-000000002201' and b.key='asset_before')
 and exists(select 1 from public.version_approvals where version_id='00000000-0000-4000-8000-000000002301'
 and actor_id='00000000-0000-4000-8000-000000002121')
 and (select to_jsonb(r)=b.value from public.revision_requests r cross join member_test_state b
 where r.asset_id='00000000-0000-4000-8000-000000002201' and b.key='revision_before'),
 'reassignment preserves terms, latest version, exact approval actor and open feedback');
select test.ok(exists(select 1 from public.operator_action_log where action='asset_approver_assigned'
 and actor_id='00000000-0000-4000-8000-000000002111' and details->>'before'='00000000-0000-4000-8000-000000002121'
 and details->>'after'='00000000-0000-4000-8000-000000002123'), 'approver reassignment records the actor and both responsible users');

-- Stale prepared uploads roll back every database change after reassignment.
set local role service_role;
select test.throws($q$select public.operator_commit_upload((select (value->>'sessionId')::uuid from member_test_state where key='prepared_old'),
 '00000000-0000-4000-8000-000000002111',repeat('e',64),32,repeat('f',64),16)$q$,'55000','prepared upload cannot commit under a reassigned approver');
reset role;
select test.ok((select latest_version_id='00000000-0000-4000-8000-000000002302' from public.assets where id='00000000-0000-4000-8000-000000002201')
 and (select count(*)=2 from public.asset_versions where asset_id='00000000-0000-4000-8000-000000002201')
 and (select to_jsonb(r)=b.value from public.revision_requests r cross join member_test_state b where r.asset_id='00000000-0000-4000-8000-000000002201' and b.key='revision_before')
 and (select s.status='prepared' from public.operator_upload_sessions s join member_test_state b on s.id=(b.value->>'sessionId')::uuid where b.key='prepared_old')
 and not exists(select 1 from public.operator_action_log l join member_test_state b on l.details->>'sessionId'=b.value->>'sessionId' where b.key='prepared_old' and l.action='asset_version_created'),
 'stale-assignee failure rolls back version, latest pointer, feedback, session and success audit');
set local role authenticated;
insert into member_test_state(key,value) select 'prepared_new',public.operator_prepare_upload(value) from member_test_state where key='upload';
reset role;
set local role service_role;
select public.operator_commit_upload((value->>'sessionId')::uuid,'00000000-0000-4000-8000-000000002111',repeat('e',64),32,repeat('f',64),16)
 from member_test_state where key='prepared_new';
reset role;
select test.ok((select a.latest_version_id=(b.value->>'versionId')::uuid from public.assets a cross join member_test_state b
 where a.id='00000000-0000-4000-8000-000000002201' and b.key='prepared_new')
 and not exists(select 1 from public.revision_requests where asset_id='00000000-0000-4000-8000-000000002201' and resolved_at is null),
 'fresh preparation under new approver commits and resolves only captured feedback');

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000002121',true);
set local role authenticated;
select test.throws($q$select public.approve_asset_version((select (value->>'versionId')::uuid from member_test_state where key='prepared_new'),'instagram','organic',true)$q$,'42501','former approver cannot approve the new version');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000002123',true);
select public.approve_asset_version((value->>'versionId')::uuid,'instagram','organic',true) from member_test_state where key='prepared_new';
select test.ok((select exists(select 1 from public.authorize_asset_download((b.value->>'versionId')::uuid,'instagram','organic') d where d.object_path is not null)
 from member_test_state b where b.key='prepared_new'),
 'new eligible approver can approve and obtain download authorization');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000002111',true);
insert into member_test_state(key,value)
 select 'upload_after',u.value||jsonb_build_object('expectedLatestVersionId',p.value->>'versionId','expectedRevisionId',null)
 from member_test_state u cross join member_test_state p where u.key='upload' and p.key='prepared_new';
insert into member_test_state(key,value) select 'before_expiry',public.operator_prepare_upload(value) from member_test_state where key='upload_after';
select public.operator_update_member(value||jsonb_build_object('expectedRevision',4,'active',true,'accessAllowed',true,
 'accessEndDate',staycut_private.contract_today()-1)) from member_test_state where key='update';
select test.throws($q$select public.operator_prepare_upload((select value from member_test_state where key='upload_after'))$q$,'42501','expired assigned member prevents new upload preparation');
reset role;
set local role service_role;
select test.throws($q$select public.operator_commit_upload((select (value->>'sessionId')::uuid from member_test_state where key='before_expiry'),
 '00000000-0000-4000-8000-000000002111',repeat('e',64),32,repeat('f',64),16)$q$,'42501','membership expiry after preparation prevents commit');
reset role;
set local role authenticated;
select public.operator_update_member(value||'{"expectedRevision":5,"active":true,"accessAllowed":true}'::jsonb) from member_test_state where key='update';
select public.operator_update_member(value||'{"expectedRevision":6}'::jsonb) from member_test_state where key='update';
reset role;
set local role service_role;
select test.throws($q$select public.operator_commit_upload((select (value->>'sessionId')::uuid from member_test_state where key='before_expiry'),
 '00000000-0000-4000-8000-000000002111',repeat('e',64),32,repeat('f',64),16)$q$,'42501','membership revocation after preparation prevents commit');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000002123',true);
select test.ok((select count(*)=0 from public.assets where id='00000000-0000-4000-8000-000000002201'), 'revoked membership immediately hides future asset reads through RLS');
select test.throws($q$select public.authorize_asset_preview((select (value->>'versionId')::uuid from member_test_state where key='prepared_new'))$q$,'42501','revocation denies new preview authorizations');
select test.throws($q$select public.authorize_asset_download((select (value->>'versionId')::uuid from member_test_state where key='prepared_new'),'instagram','organic')$q$,'42501','revocation denies new download authorizations');
reset role;
select test.ok((select count(*)=2 from public.version_approvals where asset_id='00000000-0000-4000-8000-000000002201')
 and exists(select 1 from public.tenant_members where tenant_id='00000000-0000-4000-8000-000000002101' and user_id='00000000-0000-4000-8000-000000002123' and not active),
 'revocation keeps membership identity and historical approvals intact');
select test.ok((select count(*)=1 from public.tenant_members where tenant_id='00000000-0000-4000-8000-000000002102'
 and user_id='00000000-0000-4000-8000-000000002122' and role='owner' and active and access_allowed and revision=1),
 'all member operations leave unrelated tenant access and ownership unchanged');

rollback;
\echo 'All operator member database regression assertions passed.'
